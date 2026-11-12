import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Maintenance } from "../src/jobs.js";
import { WhispcordInternal } from "../src/mcp/client.js";
import { RunEvents } from "../src/runs/events.js";
import { RunService } from "../src/runs/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeMcp, GUILD, MEMBER, USER } from "./fakes.js";

const SECRET = "test-secret-test-secret";
const OTHER_GUILD = "100000000000000999";

async function setup() {
  const config = loadConfig({
    DISCORD_CLIENT_ID: "555",
    WHISPCORD_MCP_SECRET: SECRET,
    WEB_ORIGIN: "http://localhost:3000",
    RECONCILE_INTERVAL_MINUTES: "0",
  } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  // Two signed-in users: the server manager and a regular member.
  store.addProfile({ id: "p-owner", authUserId: "u-owner", discordUserId: USER, username: "owner", manageableGuilds: [{ id: GUILD, name: "Test", icon: null, owner: true }] });
  store.addProfile({ id: "p-member", authUserId: "u-member", discordUserId: MEMBER, username: "member", manageableGuilds: [] });
  const mcp = new FakeMcp();
  const internal = new WhispcordInternal(mcp);
  const events = new RunEvents();
  const runs = new RunService({ store, mcp, internal, anthropic: null, events, config });
  const app = await buildApp({
    config, store, internal, events, runs,
    verifyToken: async (t) => (t.startsWith("tok-") ? t.slice(4) : null),
  });
  return { app, store, mcp, internal, config };
}

const auth = (user: string) => ({ authorization: `Bearer tok-${user}` });

type Ctx = Awaited<ReturnType<typeof setup>>;

async function connect(ctx: Ctx, user = "u-owner", guildId = GUILD) {
  const start = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth(user), payload: { guildId } });
  const { state } = start.json() as { state: string };
  return ctx.app.inject({ method: "POST", url: "/connect/complete", headers: auth(user), payload: { state, guildId } });
}

describe("auth", () => {
  it("rejects requests without a valid session", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/connect/start", payload: { guildId: GUILD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/connect/start", headers: { authorization: "Bearer nope" }, payload: { guildId: GUILD } })).statusCode).toBe(401);
  });
});

describe("connect flow", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("builds a locked invite URL only for servers the user manages", async () => {
    const ok = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-owner"), payload: { guildId: GUILD } });
    expect(ok.statusCode).toBe(200);
    const url = new URL((ok.json() as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get("guild_id")).toBe(GUILD);
    expect(url.searchParams.get("disable_guild_select")).toBe("true");
    expect(url.searchParams.get("permissions")).toBe("27648920593");

    const denied = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-member"), payload: { guildId: GUILD } });
    expect(denied.statusCode).toBe(403);
    const bad = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-owner"), payload: { guildId: "123" } });
    expect(bad.statusCode).toBe(400);
  });

  it("connects after verifying the bot joined and the user can manage the server", async () => {
    const res = await connect(ctx);
    expect(res.statusCode).toBe(200);
    const server = await ctx.store.getServerByGuildId(GUILD);
    expect(server?.status).toBe("connected");
    expect(await ctx.store.isServerMember(server!.id, "p-owner")).toBe(true);
  });

  it("makes the state single-use", async () => {
    const start = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-owner"), payload: { guildId: GUILD } });
    const { state } = start.json() as { state: string };
    const first = await ctx.app.inject({ method: "POST", url: "/connect/complete", headers: auth("u-owner"), payload: { state, guildId: GUILD } });
    const second = await ctx.app.inject({ method: "POST", url: "/connect/complete", headers: auth("u-owner"), payload: { state, guildId: GUILD } });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
  });

  it("rejects another user's state and a swapped guild", async () => {
    const start = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-owner"), payload: { guildId: GUILD } });
    const { state } = start.json() as { state: string };
    const stolen = await ctx.app.inject({ method: "POST", url: "/connect/complete", headers: auth("u-member"), payload: { state, guildId: GUILD } });
    expect(stolen.statusCode).toBe(400);

    const start2 = await ctx.app.inject({ method: "POST", url: "/connect/start", headers: auth("u-owner"), payload: { guildId: GUILD } });
    const s2 = (start2.json() as { state: string }).state;
    const swapped = await ctx.app.inject({ method: "POST", url: "/connect/complete", headers: auth("u-owner"), payload: { state: s2, guildId: OTHER_GUILD } });
    expect(swapped.statusCode).toBe(400);
    expect(await ctx.store.getServerByGuildId(OTHER_GUILD)).toBeNull();
  });

  it("refuses when the bot isn't in the server or the user lost Manage Server", async () => {
    ctx.mcp.botGuilds.clear();
    expect((await connect(ctx)).statusCode).toBe(409);
    ctx.mcp.botGuilds.add(GUILD);
    ctx.mcp.managers.clear();
    expect((await connect(ctx)).statusCode).toBe(403);
    expect(await ctx.store.getServerByGuildId(GUILD)).toBeNull();
  });
});

describe("server access", () => {
  it("hides servers from users who aren't members", async () => {
    const ctx = await setup();
    await connect(ctx);
    const own = await ctx.app.inject({ method: "GET", url: `/servers/${GUILD}/snapshot`, headers: auth("u-owner") });
    expect(own.statusCode).toBe(200);
    const other = await ctx.app.inject({ method: "GET", url: `/servers/${GUILD}/snapshot`, headers: auth("u-member") });
    expect(other.statusCode).toBe(404);
  });

  it("re-checks Manage Server live", async () => {
    const ctx = await setup();
    await connect(ctx);
    ctx.mcp.managers.clear();
    const res = await ctx.app.inject({ method: "GET", url: `/servers/${GUILD}/snapshot`, headers: auth("u-owner") });
    expect(res.statusCode).toBe(403);
  });

  it("only lets the owner change tiers, never enabling restricted", async () => {
    const ctx = await setup();
    await connect(ctx);
    const res = await ctx.app.inject({
      method: "PATCH", url: `/servers/${GUILD}/settings`, headers: auth("u-owner"),
      payload: { enabledTiers: ["build", "restricted", "moderate"] },
    });
    expect(res.json()).toEqual({ enabledTiers: ["read", "build", "moderate"], needsPermissionUpgrade: true });

    ctx.mcp.botPermissions = "1127294766103";
    const upgraded = await ctx.app.inject({
      method: "PATCH", url: `/servers/${GUILD}/settings`, headers: auth("u-owner"), payload: { enabledTiers: ["moderate"] },
    });
    expect((upgraded.json() as { needsPermissionUpgrade: boolean }).needsPermissionUpgrade).toBe(false);
  });

  it("offers a moderation re-invite to the owner only", async () => {
    const ctx = await setup();
    await connect(ctx);
    const res = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/permissions-upgrade`, headers: auth("u-owner") });
    expect(new URL((res.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get("permissions")).toBe("1127294766103");
    const other = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/permissions-upgrade`, headers: auth("u-member") });
    expect(other.statusCode).toBe(404);
  });

  it("returns 503 for new runs when Claude isn't configured", async () => {
    const ctx = await setup();
    await connect(ctx);
    const res = await ctx.app.inject({ method: "POST", url: `/servers/${GUILD}/runs`, headers: auth("u-owner"), payload: { prompt: "hi" } });
    expect(res.statusCode).toBe(503);
  });
});

describe("internal webhook", () => {
  it("requires the shared secret and marks servers disconnected", async () => {
    const ctx = await setup();
    await connect(ctx);
    const payload = { type: "guild_leave", guildId: GUILD };
    expect((await ctx.app.inject({ method: "POST", url: "/internal/discord-events", payload })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/internal/discord-events", headers: { authorization: "Bearer wrong" }, payload })).statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/internal/discord-events", headers: { authorization: `Bearer ${SECRET}` }, payload });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.store.getServerByGuildId(GUILD))?.status).toBe("disconnected");
  });
});

describe("account deletion", () => {
  it("deletes the profile, the servers it connected and their runs", async () => {
    const ctx = await setup();
    await connect(ctx);
    const server = (await ctx.store.getServerByGuildId(GUILD))!;
    await ctx.store.createRun({ serverId: server.id, profileId: "p-owner", kind: "prompt", prompt: "x", model: "m" });
    const res = await ctx.app.inject({ method: "DELETE", url: "/me", headers: auth("u-owner") });
    expect(res.statusCode).toBe(200);
    expect(await ctx.store.getServerByGuildId(GUILD)).toBeNull();
    expect(ctx.store.runs.size).toBe(0);
    expect(await ctx.store.getProfileByAuthUser("u-owner")).toBeNull();
    expect(await ctx.store.getProfileByAuthUser("u-member")).not.toBeNull();
  });
});

describe("health", () => {
  it("reports discord-mcp status", async () => {
    const ctx = await setup();
    expect((await ctx.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    ctx.mcp.down = true;
    const down = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(down.statusCode).toBe(503);
    expect((down.json() as { discordMcp: string }).discordMcp).toBe("down");
  });
});

describe("maintenance", () => {
  const log = { info: () => {}, warn: () => {} };

  it("marks servers disconnected when the bot has left, but not when discord-mcp is down", async () => {
    const ctx = await setup();
    await connect(ctx);
    const jobs = new Maintenance(ctx.store, ctx.internal, ctx.config, log);

    ctx.mcp.down = true;
    await jobs.reconcile();
    expect((await ctx.store.getServerByGuildId(GUILD))?.status).toBe("connected");

    ctx.mcp.down = false;
    ctx.mcp.botGuilds.clear();
    expect(await jobs.reconcile()).toEqual({ checked: 1, disconnected: 1 });
    expect((await ctx.store.getServerByGuildId(GUILD))?.status).toBe("disconnected");
  });

  it("purges servers disconnected past the retention period", async () => {
    const ctx = await setup();
    await connect(ctx);
    await ctx.store.updateServer(GUILD, { status: "disconnected" });
    const jobs = new Maintenance(ctx.store, ctx.internal, ctx.config, log);
    expect((await jobs.purge()).servers).toBe(0); // too recent
    ctx.store.servers.get(GUILD)!.statusChangedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    expect((await jobs.purge()).servers).toBe(1);
    expect(await ctx.store.getServerByGuildId(GUILD)).toBeNull();
  });

  it("fails runs interrupted by a restart", async () => {
    const ctx = await setup();
    const run = await ctx.store.createRun({ serverId: "s", profileId: "p-owner", kind: "prompt", prompt: "x", model: "m" });
    expect(await ctx.store.failInterruptedRuns("restarted")).toBe(1);
    expect((await ctx.store.getRun(run.id))?.status).toBe("failed");
  });
});
