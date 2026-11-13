import type Anthropic from "@anthropic-ai/sdk";
import { MESSAGE_MODERATION_PERMISSIONS, P, type Tier, type WatchEvent } from "@whispcord/shared";
import { describe, expect, it } from "vitest";
import { buildInverse } from "../src/agent/inverses.js";
import { validatePlan } from "../src/agent/validatePlan.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { GatewayError } from "../src/gateway/gateway.js";
import { extractCreatedId } from "../src/gateway/results.js";
import { makeImageFetcher, sniffImageType, type FetchedImage, type ImageFetcher } from "../src/live/images.js";
import { IncomingMessageSchema, LiveWatchService, type IncomingMessage } from "../src/live/watchService.js";
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

type Block = { type: "text"; text: string } | { type: "image"; source: { media_type: string; data: string } };

/**
 * Fake classifier: matches by substring and records every text it was shown. Images (fake PNGs
 * whose bytes carry a word, see fakeImage) are "read" by decoding them and checked the same way.
 */
function fakeClassifier(classify: (text: string) => "low" | "medium" | "high" | null) {
  const seen: string[] = [];
  const seenImages: Array<{ message: number; mediaType: string; text: string }> = [];
  const calls: Array<{ messages: number; images: number }> = [];
  const client = {
    messages: {
      parse: async (params: { messages: Array<{ content: string | Block[] }> }) => {
        const content = params.messages[0]!.content;
        const blocks: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
        const text = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
        const lines = text.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { i: number; text: string });
        // Images belong to the message named in the label just before them.
        const imageText = new Map<number, string>();
        let owner = -1;
        for (const b of blocks) {
          if (b.type === "text") {
            const m = /\[image \d+ of \d+ for message (\d+)\]$/.exec(b.text);
            if (m) owner = Number(m[1]);
          } else {
            const decoded = Buffer.from(b.source.data, "base64").subarray(8).toString("utf8");
            seenImages.push({ message: owner, mediaType: b.source.media_type, text: decoded });
            imageText.set(owner, `${imageText.get(owner) ?? ""} ${decoded}`);
          }
        }
        calls.push({ messages: lines.length, images: blocks.filter((b) => b.type === "image").length });
        const matches = lines
          .map((m) => {
            seen.push(m.text);
            return { i: m.i, severity: classify(`${m.text} ${imageText.get(m.i) ?? ""}`), reason: "Insults another member" };
          })
          .filter((m) => m.severity);
        return { stop_reason: "end_turn", parsed_output: { matches }, usage: { input_tokens: 100, output_tokens: 20 } };
      },
    },
  };
  return { client: client as unknown as Anthropic, seen, seenImages, calls };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A fake PNG whose bytes after the header spell out `word`, so the fake classifier can "see" it. */
const fakeImage = (word: string): FetchedImage => {
  const buf = Buffer.concat([PNG_MAGIC, Buffer.from(word)]);
  return { mediaType: "image/png", data: buf.toString("base64"), bytes: buf.length };
};
/** Fake fetcher: https://cdn.discordapp.com/attachments/1/2/<word>.png → an image showing <word>. */
function fakeFetcher() {
  const fetched: string[] = [];
  const fetchImage: ImageFetcher = async (url) => {
    fetched.push(url);
    const word = /\/([a-z]+)\.png/.exec(url)?.[1];
    return word && word !== "broken" ? fakeImage(word) : null;
  };
  return { fetchImage, fetched };
}
const img = (word: string) => ({ url: `https://cdn.discordapp.com/attachments/1/2/${word}.png?ex=1&is=2&hm=3`, contentType: "image/png", size: 1000 });

let nextMessage = 800000000000000100n;
const msg = (content: string, over: Partial<IncomingMessage> = {}): IncomingMessage => {
  const id = (nextMessage++).toString();
  return {
    type: "message_create", guildId: GUILD, channelId: GENERAL, parentChannelId: null, channelName: "general",
    messageId: id, authorId: MEMBER, authorName: "troll", createdAt: "2026-11-12T10:00:00Z", content,
    jumpUrl: `https://discord.com/channels/${GUILD}/${GENERAL}/${id}`, ...over,
  };
};

async function setup(
  tiers: Tier[] = WATCH_TIERS,
  classify = (t: string) => (t.includes("trash") ? "high" as const : t.includes("dumb") ? "medium" as const : null),
  opts: { env?: Record<string, string> } = {},
) {
  const config = loadConfig({ RECONCILE_INTERVAL_MINUTES: "0", WHISPCORD_MCP_SECRET: SECRET, WEB_ORIGIN: "http://localhost:3000", ...opts.env } as NodeJS.ProcessEnv);
  const images = fakeFetcher();
  const store = new MemoryStore();
  store.addProfile({ id: "p-owner", authUserId: "u-owner", discordUserId: USER, username: "owner", manageableGuilds: [] });
  store.addProfile({ id: "p-member", authUserId: "u-member", discordUserId: MEMBER, username: "member", manageableGuilds: [] });
  const mcp = new FakeMcp();
  const internal = new WhispcordInternal(mcp);
  await store.upsertConnectedServer({ guildId: GUILD, name: "Test", icon: null, profileId: "p-owner", botRoleOk: true });
  await store.updateServer(GUILD, { enabledTiers: tiers });
  const claude = fakeClassifier(classify);
  const live = new LiveWatchService({ store, mcp, internal, anthropic: claude.client, config, fetchImage: images.fetchImage });
  await live.refresh();
  const profile = (await store.getProfileByAuthUser("u-owner"))!;
  const server = (await store.getServerByGuildId(GUILD))!;
  const gateway = (opts: { tiers?: Tier[]; destructiveConfirmed?: boolean } = {}) =>
    makeGateway({ mcp, enabledTiers: opts.tiers ?? tiers, destructiveConfirmed: opts.destructiveConfirmed, localTools: live.localTools(server, profile, null) }).gateway;
  const events: WatchEvent[] = [];
  live.subscribe(server.id, (e) => events.push(e));
  return { config, store, mcp, internal, live, profile, server, gateway, claude, events, images };
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

describe("live watch: images", () => {
  it("flags an image-only message from what the image shows, and never stores the image", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    expect(ctx.live.ingest(msg("", { images: [img("trash")] }))).toBe(true);
    expect(ctx.live.ingest(msg("look at my cat", { images: [img("cat")] }))).toBe(true);
    await ctx.live.flushAll();

    expect(ctx.images.fetched).toHaveLength(2);
    expect(ctx.claude.seenImages.map((i) => i.text).sort()).toEqual(["cat", "trash"]);
    const flags = await ctx.store.listFlags(ctx.server.id, 10);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.excerpt).toBe("[image]");
    expect(JSON.stringify(flags)).not.toContain("cdn.discordapp.com");
  });

  it("ties each image to its own message", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    ctx.live.ingest(msg("first, harmless", { images: [img("cat")] }));
    ctx.live.ingest(msg("second", { images: [img("dog"), img("trash")] }));
    await ctx.live.flushAll();
    const flags = await ctx.store.listFlags(ctx.server.id, 10);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.excerpt).toBe("second [2 images]");
  });

  it("skips an image-only message whose image couldn't be fetched", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    ctx.live.ingest(msg("", { images: [img("broken")] }));
    await ctx.live.flushAll();
    expect(ctx.claude.calls).toHaveLength(0);
  });

  it("caps images per server per hour and says so, but keeps checking text", async () => {
    const ctx = await setup(WATCH_TIERS, undefined, { env: { LIVE_WATCH_MAX_IMAGES_PER_HOUR: "1" } });
    await startWatch(ctx, { criteria: "hurtful messages" });
    ctx.live.ingest(msg("one", { images: [img("cat")] }));
    ctx.live.ingest(msg("worthless trash", { images: [img("dog")] }));
    await ctx.live.flushAll();
    expect(ctx.images.fetched).toHaveLength(1);
    expect(ctx.events.some((e) => e.type === "notice" && e.message.includes("checked images"))).toBe(true);
    expect(await ctx.store.listFlags(ctx.server.id, 10)).toHaveLength(1);
  });

  it("splits image-heavy batches across classifier calls", async () => {
    const ctx = await setup();
    await startWatch(ctx, { criteria: "hurtful messages" });
    for (let i = 0; i < 5; i++) ctx.live.ingest(msg(`m${i}`, { images: [img("cat"), img("dog"), img("cow"), img("pig")] }));
    await ctx.live.flushAll();
    expect(ctx.claude.calls.every((c) => c.images <= 8)).toBe(true);
    expect(ctx.claude.calls.reduce((s, c) => s + c.images, 0)).toBe(20);
  });

  it("ignores images when LIVE_WATCH_IMAGES is false", async () => {
    const ctx = await setup(WATCH_TIERS, undefined, { env: { LIVE_WATCH_IMAGES: "false" } });
    await startWatch(ctx, { criteria: "hurtful messages" });
    expect(ctx.live.ingest(msg("", { images: [img("trash")] }))).toBe(false);
    ctx.live.ingest(msg("hello", { images: [img("trash")] }));
    await ctx.live.flushAll();
    expect(ctx.images.fetched).toHaveLength(0);
    expect(await ctx.store.listFlags(ctx.server.id, 10)).toHaveLength(0);
  });

  it("accepts forwarded images in the webhook payload (at most 4)", () => {
    const base = { ...msg("hi"), images: [img("cat")] };
    expect(IncomingMessageSchema.parse(base).images).toHaveLength(1);
    expect(IncomingMessageSchema.parse({ ...base, images: undefined }).images).toEqual([]);
    expect(IncomingMessageSchema.safeParse({ ...base, images: Array(5).fill(img("cat")) }).success).toBe(false);
  });
});

describe("image fetcher", () => {
  const png = Buffer.concat([PNG_MAGIC, Buffer.from("pixels")]);
  const fakeFetch = (body: Uint8Array, type = "image/png") => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return new Response(body, { headers: { "content-type": type } });
    }) as unknown as typeof fetch;
    return { f, urls };
  };

  it("fetches only from Discord's CDN over https", async () => {
    const { f, urls } = fakeFetch(png);
    const fetchImage = makeImageFetcher(f);
    for (const bad of [
      "http://cdn.discordapp.com/a.png",
      "https://evil.example/a.png",
      "https://cdn.discordapp.com.evil.example/a.png",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost:8085/mcp",
      "https://cdn.discordapp.com:8443/a.png",
      "https://user:pass@cdn.discordapp.com/a.png",
    ]) {
      expect(await fetchImage(bad)).toBeNull();
    }
    expect(urls).toEqual([]);
    expect(await fetchImage("https://media.discordapp.net/attachments/1/2/a.png")).toMatchObject({ mediaType: "image/png" });
  });

  it("rejects files that aren't really images, and anything over 5 MB", async () => {
    expect(await makeImageFetcher(fakeFetch(Buffer.from("<html>not an image</html>")).f)("https://cdn.discordapp.com/a.png")).toBeNull();
    expect(await makeImageFetcher(fakeFetch(png, "text/html").f)("https://cdn.discordapp.com/a.png")).toBeNull();
    const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(5 * 1024 * 1024)]);
    expect(await makeImageFetcher(fakeFetch(big).f)("https://cdn.discordapp.com/a.png")).toBeNull();
    // The real type comes from the bytes, not the label.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(await makeImageFetcher(fakeFetch(jpeg, "image/png").f)("https://cdn.discordapp.com/a.png")).toMatchObject({ mediaType: "image/jpeg" });
    expect(sniffImageType(Buffer.from("GIF89a"))).toBe("image/gif");
  });
});
