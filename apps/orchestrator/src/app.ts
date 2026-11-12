import { randomBytes, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MODERATION_PERMISSIONS,
  USER_TOGGLEABLE_TIERS,
  botRoleOk,
  buildBotInviteUrl,
  isSnowflake,
  isSubset,
  parsePermissions,
  type RunEvent,
  type Tier,
} from "@whispcord/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { fetchManageableGuilds } from "./discord.js";
import type { WhispcordInternal } from "./mcp/client.js";
import type { RunEvents } from "./runs/events.js";
import { HttpError, type RunService } from "./runs/service.js";
import type { Profile, Run, Server, Store } from "./store/types.js";

export interface AppDeps {
  config: Config;
  store: Store;
  internal: WhispcordInternal;
  runs: RunService;
  events: RunEvents;
  /** Resolves a Supabase access token to the auth user id. */
  verifyToken: (token: string) => Promise<string | null>;
}

export function supabaseTokenVerifier(db: SupabaseClient) {
  return async (token: string) => {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  };
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function buildApp(deps: AppDeps) {
  const { config, store, internal, runs, events } = deps;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: false,
    // @fastify/cors only allows GET, HEAD and POST unless told otherwise; settings use PATCH and
    // account deletion uses DELETE, which browsers would otherwise block ("Failed to fetch").
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: err.issues.map((i) => i.message).join("; ") });
    app.log.error(err);
    return reply.status(500).send({ error: "Something went wrong." });
  });

  // ---------- helpers ----------
  async function requireProfile(req: FastifyRequest): Promise<Profile> {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new HttpError(401, "Sign in required.");
    const userId = await deps.verifyToken(token);
    if (!userId) throw new HttpError(401, "Session expired. Sign in again.");
    const profile = await store.getProfileByAuthUser(userId);
    if (!profile || !profile.discordUserId) throw new HttpError(403, "Your account isn't linked to Discord.");
    return profile;
  }

  async function requireServer(profile: Profile, guildId: string): Promise<Server> {
    if (!isSnowflake(guildId)) throw new HttpError(400, "That doesn't look like a server ID.");
    const server = await store.getServerByGuildId(guildId);
    if (!server || !(await store.isServerMember(server.id, profile.id))) throw new HttpError(404, "Server not found.");
    return server;
  }

  async function requireRun(profile: Profile, runId: string): Promise<{ run: Run; server: Server }> {
    if (!z.string().uuid().safeParse(runId).success) throw new HttpError(404, "Run not found.");
    const run = await store.getRun(runId);
    if (!run) throw new HttpError(404, "Run not found.");
    const server = await store.getServerById(run.serverId);
    if (!server || !(await store.isServerMember(server.id, profile.id))) throw new HttpError(404, "Run not found.");
    return { run, server };
  }

  // ---------- health ----------
  // 503 when discord-mcp is unreachable, so load balancers and uptime checks notice.
  app.get("/health", async (_req, reply) => {
    try {
      await Promise.race([
        internal.botStatus("0"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      return { ok: true, discordMcp: "up" };
    } catch (err) {
      return reply.status(503).send({ ok: false, discordMcp: "down", error: (err as Error).message });
    }
  });

  // ---------- account ----------
  app.post("/me/discord-guilds", async (req) => {
    const profile = await requireProfile(req);
    const body = z.object({ providerToken: z.string().min(10) }).parse(req.body);
    const guilds = await fetchManageableGuilds(body.providerToken, profile.discordUserId).catch((err: Error) => {
      throw new HttpError(400, err.message);
    });
    await store.setManageableGuilds(profile.id, guilds);
    return { guilds };
  });

  /** Deletes the account and everything Whispcord stored for it (Discord Developer Policy). */
  app.delete("/me", async (req) => {
    const profile = await requireProfile(req);
    await store.deleteAccount(profile.id);
    return {
      ok: true,
      note: "Your Whispcord data is deleted. The bot stays in your servers until you remove it in Discord.",
    };
  });

  // ---------- connect flow ----------
  app.post("/connect/start", async (req) => {
    const profile = await requireProfile(req);
    const { guildId } = z.object({ guildId: z.string() }).parse(req.body);
    if (!isSnowflake(guildId)) throw new HttpError(400, "Server IDs are 17–20 digit numbers.");
    if (!config.DISCORD_CLIENT_ID) throw new HttpError(503, "DISCORD_CLIENT_ID is not configured.");
    if (!profile.manageableGuilds.some((g) => g.id === guildId)) {
      throw new HttpError(403, "You need Manage Server on this server. If you just got it, sign out and back in to refresh your server list.");
    }
    const state = randomBytes(24).toString("base64url");
    await store.createConnectAttempt({ profileId: profile.id, guildId, state, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
    return {
      state,
      authorizeUrl: buildBotInviteUrl({ clientId: config.DISCORD_CLIENT_ID, guildId, redirectUri: config.DISCORD_BOT_REDIRECT_URI, state }),
    };
  });

  app.post("/connect/complete", async (req) => {
    const profile = await requireProfile(req);
    const body = z.object({ state: z.string().min(10), guildId: z.string() }).parse(req.body);
    const attempt = await store.consumeConnectAttempt(body.state);
    if (!attempt || attempt.profileId !== profile.id) throw new HttpError(400, "This connect link expired or was already used. Start again.");
    if (attempt.guildId !== body.guildId) throw new HttpError(400, "Discord returned a different server than the one you picked.");

    const status = await internal.botStatus(attempt.guildId);
    if (!status.inGuild) throw new HttpError(409, "Whispcord's bot isn't in that server yet. Finish the Discord authorization and try again.");
    const perms = await internal.memberPermissions(attempt.guildId, profile.discordUserId);
    if (!perms.canManageServer) throw new HttpError(403, "You need Manage Server on this server.");

    const server = await store.upsertConnectedServer({
      guildId: attempt.guildId,
      name: status.guildName ?? attempt.guildId,
      icon: status.guildIcon ?? null,
      profileId: profile.id,
      botRoleOk: botRoleOk(status),
    });
    return { server, botStatus: status };
  });

  // ---------- servers ----------
  app.get<{ Params: { guildId: string } }>("/servers/:guildId/bot-status", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    const status = await internal.botStatus(server.guildId);
    const ok = botRoleOk(status);
    if (!status.inGuild) await store.updateServer(server.guildId, { status: "disconnected" });
    else if (ok !== server.botRoleOk) await store.updateServer(server.guildId, { botRoleOk: ok });
    return { status, botRoleOk: ok };
  });

  app.get<{ Params: { guildId: string } }>("/servers/:guildId/snapshot", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    const perms = await internal.memberPermissions(server.guildId, profile.discordUserId);
    if (!perms.canManageServer) throw new HttpError(403, "You need Manage Server on this server.");
    return internal.snapshot(server.guildId);
  });

  app.patch<{ Params: { guildId: string } }>("/servers/:guildId/settings", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    if (server.ownerProfileId !== profile.id) throw new HttpError(403, "Only the person who connected this server can change its settings.");
    const body = z.object({ enabledTiers: z.array(z.string()) }).parse(req.body);
    const tiers = body.enabledTiers.filter((t): t is Tier => (USER_TOGGLEABLE_TIERS as string[]).includes(t));
    const enabledTiers: Tier[] = ["read", ...tiers];
    await store.updateServer(server.guildId, { enabledTiers });
    // Moderation tools need permissions the Builder invite didn't grant.
    let needsPermissionUpgrade = false;
    if (enabledTiers.includes("moderate")) {
      const status = await internal.botStatus(server.guildId);
      needsPermissionUpgrade = status.inGuild && !isSubset(MODERATION_PERMISSIONS, parsePermissions(status.permissions));
    }
    return { enabledTiers, needsPermissionUpgrade };
  });

  /**
   * Re-authorizes the bot with Builder + Moderation permissions. Reuses the connect flow:
   * Discord redirects to /connect/callback, which calls /connect/complete.
   */
  app.post<{ Params: { guildId: string } }>("/servers/:guildId/permissions-upgrade", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    if (server.ownerProfileId !== profile.id) throw new HttpError(403, "Only the person who connected this server can change the bot's permissions.");
    if (!config.DISCORD_CLIENT_ID) throw new HttpError(503, "DISCORD_CLIENT_ID is not configured.");
    const perms = await internal.memberPermissions(server.guildId, profile.discordUserId);
    if (!perms.canManageServer) throw new HttpError(403, "You need Manage Server on this server.");
    const state = randomBytes(24).toString("base64url");
    await store.createConnectAttempt({ profileId: profile.id, guildId: server.guildId, state, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
    return {
      authorizeUrl: buildBotInviteUrl({
        clientId: config.DISCORD_CLIENT_ID,
        guildId: server.guildId,
        redirectUri: config.DISCORD_BOT_REDIRECT_URI,
        state,
        permissions: MODERATION_PERMISSIONS,
      }),
    };
  });

  app.post<{ Params: { guildId: string } }>("/servers/:guildId/disconnect", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    if (server.ownerProfileId === profile.id) {
      await store.updateServer(server.guildId, { status: "disconnected" });
    } else {
      await store.removeServerMember(server.id, profile.id);
    }
    return { ok: true, note: "To remove the bot itself, kick Whispcord from your server in Discord." };
  });

  // ---------- runs ----------
  app.post<{ Params: { guildId: string } }>("/servers/:guildId/runs", async (req) => {
    const profile = await requireProfile(req);
    const server = await requireServer(profile, req.params.guildId);
    const { prompt } = z.object({ prompt: z.string() }).parse(req.body);
    const run = await runs.startRun(server, profile, prompt);
    return { runId: run.id };
  });

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (req) => {
    const profile = await requireProfile(req);
    const { run } = await requireRun(profile, req.params.runId);
    const actions = await store.listActions(run.id);
    const { conversation: _c, ...rest } = run;
    return { run: { ...rest, pendingQuestion: run.pendingQuestion ? { question: run.pendingQuestion.question } : null }, actions };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/answer", async (req) => {
    const profile = await requireProfile(req);
    const { run, server } = await requireRun(profile, req.params.runId);
    const { answer } = z.object({ answer: z.string() }).parse(req.body);
    await runs.answer(run, server, profile, answer);
    return { ok: true };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/approve", async (req) => {
    const profile = await requireProfile(req);
    const { run, server } = await requireRun(profile, req.params.runId);
    const body = z.object({ stepIds: z.array(z.string()), confirmation: z.string().optional() }).parse(req.body);
    await runs.approve(run, server, profile, body.stepIds, body.confirmation);
    return { ok: true };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/retry", async (req) => {
    const profile = await requireProfile(req);
    const { run, server } = await requireRun(profile, req.params.runId);
    await runs.retry(run, server, profile);
    return { ok: true };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/fix", async (req) => {
    const profile = await requireProfile(req);
    const { run, server } = await requireRun(profile, req.params.runId);
    const next = await runs.fix(run, server, profile);
    return { runId: next.id };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/undo", async (req) => {
    const profile = await requireProfile(req);
    const { run, server } = await requireRun(profile, req.params.runId);
    const next = await runs.undo(run, server, profile);
    return { runId: next.id };
  });

  app.post<{ Params: { runId: string } }>("/runs/:runId/cancel", async (req) => {
    const profile = await requireProfile(req);
    const { run } = await requireRun(profile, req.params.runId);
    await runs.cancel(run);
    return { ok: true };
  });

  /**
   * Server-sent events for live progress. Uses fetch-streaming on the client (EventSource can't
   * send an Authorization header).
   */
  app.get<{ Params: { runId: string } }>("/runs/:runId/events", async (req, reply: FastifyReply) => {
    const profile = await requireProfile(req);
    const { run } = await requireRun(profile, req.params.runId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": config.WEB_ORIGIN,
    });
    const send = (e: RunEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: "status", runId: run.id, status: run.status });
    const unsubscribe = events.subscribe(run.id, send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---------- internal (discord-mcp → orchestrator) ----------
  app.post("/internal/discord-events", async (req, reply) => {
    const header = req.headers.authorization ?? "";
    if (!config.WHISPCORD_MCP_SECRET || !safeEqual(header, `Bearer ${config.WHISPCORD_MCP_SECRET}`)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const body = z.object({ type: z.enum(["guild_join", "guild_leave"]), guildId: z.string(), guildName: z.string().optional() }).parse(req.body);
    if (body.type === "guild_leave") {
      const server = await store.getServerByGuildId(body.guildId);
      if (server) await store.updateServer(body.guildId, { status: "disconnected" });
    }
    return { ok: true };
  });

  return app;
}
