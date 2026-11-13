import type Anthropic from "@anthropic-ai/sdk";
import { MESSAGE_MODERATION_PERMISSIONS, P, type Tier, type WatchEvent } from "@whispcord/shared";
import { describe, expect, it } from "vitest";
import { buildInverse } from "../src/agent/inverses.js";
import { validatePlan } from "../src/agent/validatePlan.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { GatewayError } from "../src/gateway/gateway.js";
import { extractCreatedId } from "../src/gateway/results.js";
import { LiveWatchService, type IncomingMessage } from "../src/live/watchService.js";
import { WhispcordInternal } from "../src/mcp/client.js";
import { RunEvents } from "../src/runs/events.js";
import { RunService } from "../src/runs/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { CAT, FakeMcp, GENERAL, GUILD, MANAGER_PERMS, MEMBER, OTHER_GUILD_CHANNEL, SNAPSHOT, TOOL_DEFS, USER, makeGateway } from "./fakes.js";

const SECRET = "test-secret-test-secret";
const limits = { maxToolCalls: 60, maxCreations: 50, maxDeletions: 10 };
const WATCH_TIERS: Tier[] = ["read", "build", "live_watch"];
const DELETE_TIERS: Tier[] = ["read", "build", "destructive", "live_watch"];
/** Manager permissions plus Manage Messages. */
const MESSAGE_MANAGER_PERMS = (BigInt(MANAGER_PERMS) | P.MANAGE_MESSAGES).toString();

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof GatewayError ? e.code : `unexpected: ${(e as Error).message}`;
  }
};

/** Fake classifier: matches by substring and records every text it was shown. */
function fakeClassifier(classify: (text: string) => "low" | "medium" | "high" | null) {
  const seen: string[] = [];
  const client = {
    messages: {
      parse: async (params: { messages: Array<{ content: string }> }) => {
        const lines = params.messages[0]!.content.split("\n").filter((l) => l.startsWith("{"));
        const matches = lines
          .map((l) => JSON.parse(l) as { i: number; text: string })
          .map((m) => {
            seen.push(m.text);
            return { i: m.i, severity: classify(m.text), reason: "Insults another member" };
          })
          .filter((m) => m.severity);
        return { stop_reason: "end_turn", parsed_output: { matches }, usage: { input_tokens: 100, output_tokens: 20 } };
      },
    },
  };
  return { client: client as unknown as Anthropic, seen };
}

let nextMessage = 800000000000000100n;
const msg = (content: string, over: Partial<IncomingMessage> = {}): IncomingMessage => {
  const id = (nextMessage++).toString();
  return {
    type: "message_create", guildId: GUILD, channelId: GENERAL, parentChannelId: null, channelName: "general",
    messageId: id, authorId: MEMBER, authorName: "troll", createdAt: "2026-11-12T10:00:00Z", content,
    jumpUrl: `https://discord.com/channels/${GUILD}/${GENERAL}/${id}`, ...over,
  };
};

async function setup(tiers: Tier[] = WATCH_TIERS, classify = (t: string) => (t.includes("trash") ? "high" as const : t.includes("dumb") ? "medium" as const : null)) {
  const config = loadConfig({ RECONCILE_INTERVAL_MINUTES: "0", WHISPCORD_MCP_SECRET: SECRET, WEB_ORIGIN: "http://localhost:3000" } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  store.addProfile({ id: "p-owner", authUserId: "u-owner", discordUserId: USER, username: "owner", manageableGuilds: [] });
  store.addProfile({ id: "p-member", authUserId: "u-member", discordUserId: MEMBER, username: "member", manageableGuilds: [] });
  const mcp = new FakeMcp();
  const internal = new WhispcordInternal(mcp);
  await store.upsertConnectedServer({ guildId: GUILD, name: "Test", icon: null, profileId: "p-owner", botRoleOk: true });
  await store.updateServer(GUILD, { enabledTiers: tiers });
  const claude = fakeClassifier(classify);
  const live = new LiveWatchService({ store, mcp, internal, anthropic: claude.client, config });
  await live.refresh();
  const profile = (await store.getProfileByAuthUser("u-owner"))!;
  const server = (await store.getServerByGuildId(GUILD))!;
  const gateway = (opts: { tiers?: Tier[]; destructiveConfirmed?: boolean } = {}) =>
    makeGateway({ mcp, enabledTiers: opts.tiers ?? tiers, destructiveConfirmed: opts.destructiveConfirmed, localTools: live.localTools(server, profile, null) }).gateway;
  const events: WatchEvent[] = [];
  live.subscribe(server.id, (e) => events.push(e));
  return { config, store, mcp, internal, live, profile, server, gateway, claude, events };
}

async function startWatch(ctx: Awaited<ReturnType<typeof setup>>, args: Record<string, string>, opts: { destructiveConfirmed?: boolean } = {}) {
  const res = await ctx.gateway(opts).call("start_live_watch", args);
  expect(res.isError).toBe(false);
  return res.createdId!;
}

describe("live watch: gateway and plan rules", () => {
  it("is blocked unless the server switched on Live watch", async () => {
    const ctx = await setup(["read", "build", "destructive"]);
    expect(await code(ctx.gateway().call("start_live_watch", { criteria: "hurtful messages" }))).toBe("tool_blocked");
    expect(ctx.gateway().claudeTools().map((t) => t.name)).not.toContain("start_live_watch");
    expect(await ctx.store.listActiveWatches()).toHaveLength(0);
  });

  it("only watches channels in the run's guild", async () => {
    const ctx = await setup();
    expect(await code(ctx.gateway().call("start_live_watch", { criteria: "hurtful", channelIds: `${GENERAL},${OTHER_GUILD_CHANNEL}` }))).toBe("foreign_id");
    expect(await code(ctx.gateway().call("start_live_watch", { criteria: "hurtful", guildId: "123456789012345678" }))).toBe("foreign_id");
    expect(await ctx.store.listActiveWatches()).toHaveLength(0);
  });

  it("never lets a discord-mcp tool stand in for a local one", async () => {
    const mcp = new FakeMcp();
    const fakeUpstream = { name: "start_live_watch", description: "x", inputSchema: { type: "object" as const, properties: { criteria: { type: "string" } }, required: [] } };
    const { gateway } = makeGateway({ mcp, enabledTiers: WATCH_TIERS, toolDefs: [...TOOL_DEFS, fakeUpstream] });
    expect(await code(gateway.call("start_live_watch", { criteria: "hurtful" }))).toBe("tool_blocked");
    expect(mcp.calls.some((c) => c.name === "start_live_watch")).toBe(false);
  });

  it("treats a flag-only watch as an ordinary write, but an auto-delete watch as a deletion", async () => {
    const ctx = await setup(DELETE_TIERS);
    const flagOnly = await validatePlan(
      { summary: "watch", steps: [{ id: "s1", tool: "start_live_watch", args: { criteria: "hurtful messages" }, reason: "", risk: "low" }] },
      ctx.gateway(), limits, { confirmationPhrase: "DELETE" },
    );
    expect(flagOnly.requiresConfirmation).toBe(false);
    expect(flagOnly.steps[0]!.destructive).toBe(false);

    const autoDelete = await validatePlan(
      { summary: "watch", steps: [{ id: "s1", tool: "start_live_watch", args: { criteria: "hurtful messages", autoDelete: "true" }, reason: "", risk: "high" }] },
      ctx.gateway(), limits, { confirmationPhrase: "DELETE" },
    );
    expect(autoDelete.requiresConfirmation).toBe(true);
    expect(autoDelete.confirmationPhrase).toBe("DELETE");
    expect(autoDelete.steps[0]!.destructive).toBe(true);
  });

  it("won't start an auto-delete watch without typed confirmation or with Deletions off", async () => {
    const ctx = await setup(DELETE_TIERS);
    expect(await code(ctx.gateway().call("start_live_watch", { criteria: "hurtful", autoDelete: "true" }))).toBe("confirmation_required");
    expect(await code(ctx.gateway({ tiers: WATCH_TIERS, destructiveConfirmed: true }).call("start_live_watch", { criteria: "hurtful", autoDelete: "true" }))).toBe("tool_blocked");
    expect(await ctx.store.listActiveWatches()).toHaveLength(0);
  });

  it("refuses auto-delete when the requester couldn't delete messages themselves (no escalation)", async () => {
    const ctx = await setup(DELETE_TIERS);
    ctx.mcp.botPermissions = MESSAGE_MODERATION_PERMISSIONS.toString();
    const res = await ctx.gateway({ destructiveConfirmed: true }).call("start_live_watch", { criteria: "hurtful", autoDelete: "true" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Manage Messages/);
    expect(await ctx.store.listActiveWatches()).toHaveLength(0);
  });

  it("can only stop watches that belong to the run's server", async () => {
    const ctx = await setup();
    const foreign = await ctx.store.createWatch({
      serverId: "another-server", runId: null, createdBy: "p-x", createdByDiscordId: MEMBER, criteria: "spam", channelIds: [], autoDelete: false,
    });
    const res = await ctx.gateway().call("stop_live_watch", { watchId: foreign.id });
    expect(res.isError).toBe(true);
    expect((await ctx.store.getWatch(foreign.id))!.status).toBe("active");
  });

  it("undoes a watch by stopping it", async () => {
    const ctx = await setup();
    const id = await startWatch(ctx, { criteria: "hurtful messages" });
    expect(extractCreatedId("start_live_watch", `Live watch started (Watch ID: ${id}).`)).toBe(id);
    const inverse = buildInverse({ tool: "start_live_watch", args: {}, createdId: id, before: null, snapshot: SNAPSHOT });
    expect(inverse).toEqual({ tool: "stop_live_watch", args: { watchId: id } });
    expect((await ctx.gateway().call(inverse!.tool, inverse!.args)).isError).toBe(false);
    expect((await ctx.store.getWatch(id))!.status).toBe("stopped");
  });

  it("gives the planner watch settings only, never message text", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    ctx.live.ingest(msg("you are worthless trash"));
    await ctx.live.flushAll();
    const listed = await ctx.gateway().call("list_live_watches", {});
    expect(listed.text).toContain("hurtful messages");
    expect(listed.text).not.toContain("worthless");
  });
});

describe("live watch: flagging new messages", () => {
  it("only forwards and classifies servers with an active watch", async () => {
    const ctx = await setup();
    expect(ctx.mcp.liveWatchGuilds).toEqual([]);
    expect(ctx.live.ingest(msg("you are worthless trash"))).toBe(false);

    await startWatch(ctx, { criteria: "hurtful messages" });
    expect(ctx.mcp.liveWatchGuilds).toEqual([GUILD]);
    expect(ctx.live.ingest(msg("you are worthless trash", { guildId: "100000000000000999" }))).toBe(false);
    expect(ctx.live.ingest(msg("have a nice day"))).toBe(true);
    expect(ctx.live.ingest(msg("you are worthless trash"))).toBe(true);
    await ctx.live.flushAll();

    const flags = await ctx.store.listFlags(ctx.server.id, 10);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "high", action: "none", excerpt: "you are worthless trash", authorId: MEMBER });
    expect(ctx.events.some((e) => e.type === "flag" && e.flag.id === flags[0]!.id)).toBe(true);
  });

  it("respects the watch's channels, including threads under them", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages", channelIds: CAT });
    ctx.live.ingest(msg("trash in general"));
    ctx.live.ingest(msg("trash in a thread", { channelId: "200000000000000077", parentChannelId: CAT }));
    await ctx.live.flushAll();
    expect(ctx.claude.seen).toEqual(["trash in a thread"]);
  });

  it("pauses when Live watch is switched off", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    await ctx.store.updateServer(GUILD, { enabledTiers: ["read", "build"] });
    await ctx.live.refresh();
    expect(ctx.mcp.liveWatchGuilds).toEqual([]);
    expect(ctx.live.ingest(msg("you are worthless trash"))).toBe(false);
  });

  it("auto-deletes only high-severity matches, after re-checking the creator's permissions", async () => {
    const ctx = await setup(DELETE_TIERS);
    ctx.mcp.botPermissions = MESSAGE_MODERATION_PERMISSIONS.toString();
    ctx.mcp.memberPermissions = MESSAGE_MANAGER_PERMS;
    await startWatch(ctx, { criteria: "hurtful messages", autoDelete: "true" }, { destructiveConfirmed: true });

    const high = msg("you are worthless trash");
    const medium = msg("that was dumb");
    ctx.live.ingest(high);
    ctx.live.ingest(medium);
    await ctx.live.flushAll();

    const deletes = ctx.mcp.calls.filter((c) => c.name === "delete_message");
    expect(deletes).toEqual([{ name: "delete_message", args: { channelId: GENERAL, messageId: high.messageId } }]);
    const flags = await ctx.store.listFlags(ctx.server.id, 10);
    expect(flags.find((f) => f.messageId === high.messageId)!.action).toBe("auto_deleted");
    expect(flags.find((f) => f.messageId === medium.messageId)!.action).toBe("none");
  });

  it("only flags when the creator lost Manage Messages or Deletions was switched off", async () => {
    const ctx = await setup(DELETE_TIERS);
    ctx.mcp.botPermissions = MESSAGE_MODERATION_PERMISSIONS.toString();
    ctx.mcp.memberPermissions = MESSAGE_MANAGER_PERMS;
    await startWatch(ctx, { criteria: "hurtful messages", autoDelete: "true" }, { destructiveConfirmed: true });

    ctx.mcp.memberPermissions = MANAGER_PERMS; // lost Manage Messages
    ctx.live.ingest(msg("you are worthless trash"));
    await ctx.live.flushAll();
    expect(ctx.mcp.calls.some((c) => c.name === "delete_message")).toBe(false);
    expect((await ctx.store.listFlags(ctx.server.id, 10))[0]!.action).toBe("auto_delete_failed");

    await ctx.store.updateServer(GUILD, { enabledTiers: WATCH_TIERS });
    await ctx.live.refresh();
    ctx.live.ingest(msg("more worthless trash"));
    await ctx.live.flushAll();
    expect(ctx.mcp.calls.some((c) => c.name === "delete_message")).toBe(false);
  });

  it("stops checking messages at the hourly limit", async () => {
    const ctx = await setup();
    (ctx.config as { LIVE_WATCH_MAX_MESSAGES_PER_HOUR: number }).LIVE_WATCH_MAX_MESSAGES_PER_HOUR = 2;
    await startWatch(ctx, { criteria: "hurtful messages" });
    for (const t of ["trash 1", "trash 2", "trash 3"]) ctx.live.ingest(msg(t));
    await ctx.live.flushAll();
    expect(ctx.claude.seen).toEqual(["trash 1", "trash 2"]);
    expect(ctx.events.some((e) => e.type === "notice" && e.level === "warn")).toBe(true);
  });
});

describe("live watch: API", () => {
  async function appSetup() {
    const ctx = await setup();
    const events = new RunEvents();
    const runs = new RunService({ store: ctx.store, mcp: ctx.mcp, internal: ctx.internal, anthropic: null, events, config: ctx.config, live: ctx.live });
    const app = await buildApp({
      config: ctx.config, store: ctx.store, internal: ctx.internal, events, runs, live: ctx.live,
      verifyToken: async (t) => (t.startsWith("tok-") ? t.slice(4) : null),
    });
    return { ...ctx, app };
  }
  const auth = (user: string) => ({ authorization: `Bearer tok-${user}` });

  it("accepts forwarded messages only with the shared secret", async () => {
    const ctx = await appSetup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    const payload = msg("you are worthless trash");
    expect((await ctx.app.inject({ method: "POST", url: "/internal/discord-events", payload })).statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/internal/discord-events", headers: { authorization: `Bearer ${SECRET}` }, payload });
    expect(ok.json()).toEqual({ ok: true, queued: true });
    const bad = await ctx.app.inject({ method: "POST", url: "/internal/discord-events", headers: { authorization: `Bearer ${SECRET}` }, payload: { ...payload, guildId: "nope" } });
    expect(bad.statusCode).toBe(400);
  });

  it("shows flags to server members only, and needs Manage Server to dismiss", async () => {
    const ctx = await appSetup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    ctx.live.ingest(msg("you are worthless trash"));
    await ctx.live.flushAll();

    const overview = await ctx.app.inject({ method: "GET", url: `/servers/${GUILD}/watch`, headers: auth("u-owner") });
    const body = overview.json() as { flags: Array<{ id: string; excerpt: string }>; watches: unknown[]; paused: string | null };
    expect(body.watches).toHaveLength(1);
    expect(body.flags[0]!.excerpt).toBe("you are worthless trash");
    expect(body.paused).toBeNull();

    expect((await ctx.app.inject({ method: "GET", url: `/servers/${GUILD}/watch`, headers: auth("u-member") })).statusCode).toBe(404);

    ctx.mcp.managers.clear();
    const denied = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/flags/${body.flags[0]!.id}/dismiss`, headers: auth("u-owner") });
    expect(denied.statusCode).toBe(403);
    ctx.mcp.managers.add(USER);
    const dismissed = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/flags/${body.flags[0]!.id}/dismiss`, headers: auth("u-owner") });
    expect((dismissed.json() as { flag: { action: string } }).flag.action).toBe("dismissed");
  });

  it("asks for Manage Messages when Live watch and Deletions are both on", async () => {
    const ctx = await appSetup();
    const res = await ctx.app.inject({
      method: "PATCH", url: `/servers/${GUILD}/settings`, headers: auth("u-owner"),
      payload: { enabledTiers: ["build", "destructive", "live_watch"] },
    });
    expect(res.json()).toMatchObject({ needsPermissionUpgrade: true });
    ctx.config.DISCORD_CLIENT_ID = "555";
    const upgrade = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/permissions-upgrade`, headers: auth("u-owner") });
    const perms = BigInt(new URL((upgrade.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("permissions")!);
    expect(perms & P.MANAGE_MESSAGES).toBe(P.MANAGE_MESSAGES);
  });
});
