import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { DiscordChatService, formatPlan, type Mention } from "../src/chat/discordChat.js";
import { loadConfig } from "../src/config.js";
import { WhispcordInternal } from "../src/mcp/client.js";
import { RunEvents } from "../src/runs/events.js";
import { RunService } from "../src/runs/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { CAT, FakeMcp, GENERAL, GUILD, MEMBER, USER } from "./fakes.js";

const SECRET = "test-secret-test-secret";
const CHANNEL = GENERAL;
const OTHER_GUILD = "100000000000000999";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Fake Claude: replays scripted tool calls and records every request. */
function fakeClaude(responses: unknown[][]) {
  const requests: Params[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          requests.push(structuredClone(params));
          const content = responses[Math.min(i++, responses.length - 1)]!;
          return {
            content,
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const proposePlan = (steps: unknown[]) => [{ type: "tool_use", id: "t-plan", name: "propose_plan", input: { summary: "Add a clips channel", steps } }];
const CREATE_STEP = { id: "s1", tool: "create_text_channel", args: { name: "clips", categoryId: CAT }, reason: "Add #clips under Info", risk: "low" };
const DELETE_STEP = { id: "s1", tool: "delete_channel", args: { channelId: GENERAL }, reason: "Remove #general", risk: "high" };

async function setup(responses: unknown[][] = [proposePlan([CREATE_STEP])]) {
  const config = loadConfig({ WHISPCORD_MCP_SECRET: SECRET, WEB_ORIGIN: "https://whispcord.test", RECONCILE_INTERVAL_MINUTES: "0" } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  store.addProfile({ id: "p-owner", authUserId: "u-owner", discordUserId: USER, username: "owner", manageableGuilds: [] });
  store.addProfile({ id: "p-member", authUserId: "u-member", discordUserId: MEMBER, username: "member", manageableGuilds: [] });
  await store.upsertConnectedServer({ guildId: GUILD, name: "Test", icon: null, profileId: "p-owner", botRoleOk: true });
  await store.updateServer(GUILD, { enabledTiers: ["read", "build", "destructive"] });
  const mcp = new FakeMcp();
  const internal = new WhispcordInternal(mcp);
  const events = new RunEvents();
  const claude = fakeClaude(responses);
  const runs = new RunService({ store, mcp, internal, anthropic: claude.client, events, config });
  const chat = new DiscordChatService({ store, runs, events, internal, config });
  const app = await buildApp({ config, store, internal, events, runs, chat, verifyToken: async () => null });
  return { app, store, mcp, chat, claude, runs };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

let nextMsg = 600000000000000000n;
function mention(over: Partial<Mention> = {}): Mention {
  return {
    type: "mention", guildId: GUILD, channelId: CHANNEL, messageId: (nextMsg++).toString(), authorId: USER,
    content: "add a clips channel", replyToMessageId: null, ...over,
  };
}

const runsOf = (ctx: Ctx) => [...ctx.store.runs.values()];
const writes = (ctx: Ctx) => ctx.mcp.calls.filter((c) => c.name.startsWith("create_") || c.name.startsWith("delete_"));
const lastPost = (ctx: Ctx) => ctx.mcp.chatPosts.at(-1)!;

async function planned(ctx: Ctx, m = mention()) {
  await ctx.chat.handleMention(m);
  await vi.waitFor(() => expect(lastPost(ctx)?.buttons).toBeTruthy());
  return { run: runsOf(ctx)[0]!, post: lastPost(ctx), mention: m };
}

function click(ctx: Ctx, runId: string, over: Record<string, unknown> = {}) {
  return ctx.chat.handleInteraction({
    type: "interaction", action: "approve", runId, guildId: GUILD, channelId: CHANNEL, messageId: "600000000000009999", userId: USER, ...over,
  } as Parameters<DiscordChatService["handleInteraction"]>[0]);
}

describe("Discord chat: mentions", () => {
  it("plans from the mention and replies with Approve/Cancel, changing nothing yet", async () => {
    const ctx = await setup();
    const { run, post, mention: m } = await planned(ctx);
    expect(run.prompt).toBe("add a clips channel");
    expect(run.status).toBe("awaiting_approval");
    expect(post.replyToMessageId).toBe(m.messageId);
    expect(post.content).toContain("Add #clips under Info");
    expect(post.buttons).toBe(`approve:${run.id},cancel:${run.id}`);
    expect(writes(ctx)).toHaveLength(0);
  });

  it("sends the planner only the mention text, as the request", async () => {
    const ctx = await setup();
    await planned(ctx, mention({ content: "add a clips channel please" }));
    const first = ctx.claude.requests[0]!.messages[0]!.content as Array<{ text: string }>;
    expect(first.at(-1)!.text).toBe("<request>\nadd a clips channel please\n</request>");
  });

  it("re-checks Manage Server live, and refuses without starting a run", async () => {
    const ctx = await setup();
    ctx.mcp.managers.delete(USER);
    await ctx.chat.handleMention(mention());
    expect(runsOf(ctx)).toHaveLength(0);
    expect(lastPost(ctx).content).toMatch(/Manage Server/);
    expect(ctx.claude.requests).toHaveLength(0);
  });

  it("asks unknown users to sign in and unconnected servers to connect, without calling Claude", async () => {
    const ctx = await setup();
    await ctx.chat.handleMention(mention({ authorId: "400000000000000777" }));
    expect(lastPost(ctx).content).toMatch(/Sign in once at https:\/\/whispcord\.test/);
    await ctx.chat.handleMention(mention({ guildId: OTHER_GUILD }));
    expect(lastPost(ctx).content).toMatch(/isn't connected/);
    await ctx.store.updateServer(GUILD, { status: "disconnected" });
    await ctx.chat.handleMention(mention());
    expect(lastPost(ctx).content).toMatch(/isn't connected/);
    expect(runsOf(ctx)).toHaveLength(0);
    expect(ctx.claude.requests).toHaveLength(0);
  });

  it("explains how to use it when the mention has no request", async () => {
    const ctx = await setup();
    await ctx.chat.handleMention(mention({ content: "   " }));
    expect(lastPost(ctx).content).toMatch(/Tell me what to change/);
    expect(runsOf(ctx)).toHaveLength(0);
  });

  it("answers a clarifying question when the requester replies to it, and only them", async () => {
    const ctx = await setup([
      [{ type: "tool_use", id: "t-q", name: "ask_clarification", input: { question: "Which category?" } }],
      proposePlan([CREATE_STEP]),
    ]);
    await ctx.chat.handleMention(mention());
    await vi.waitFor(() => expect(lastPost(ctx)?.content).toContain("Which category?"));
    const question = lastPost(ctx);
    const run = runsOf(ctx)[0]!;
    expect(run.status).toBe("needs_input");

    ctx.mcp.managers.add(MEMBER);
    await ctx.chat.handleMention(mention({ authorId: MEMBER, content: "delete everything", replyToMessageId: question.messageId }));
    expect(lastPost(ctx).content).toMatch(/Only the person who started/);
    expect((await ctx.store.getRun(run.id))!.status).toBe("needs_input");

    await ctx.chat.handleMention(mention({ content: "Info", replyToMessageId: question.messageId }));
    await vi.waitFor(() => expect(lastPost(ctx)?.buttons).toBe(`approve:${run.id},cancel:${run.id}`));
    expect(runsOf(ctx)).toHaveLength(1);
  });
});

describe("Discord chat: approval buttons", () => {
  it("runs the plan only after the requester approves, then reports back", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    const res = await click(ctx, run.id);
    expect(res).toEqual({ text: "Approved. I'm on it.", done: true });
    await vi.waitFor(() => expect(lastPost(ctx).content).toMatch(/^Done\. 1 step ran/));
    expect(writes(ctx).map((c) => c.name)).toEqual(["create_text_channel"]);
    expect((await ctx.store.getRun(run.id))!.status).toBe("done");
  });

  it("lets only the person who asked approve, even another server manager", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    ctx.mcp.managers.add(MEMBER);
    expect(await click(ctx, run.id, { userId: MEMBER })).toMatchObject({ done: false, text: expect.stringMatching(/Only the person who asked/) });
    expect(await click(ctx, run.id, { userId: "400000000000000777" })).toMatchObject({ done: false });
    expect(writes(ctx)).toHaveLength(0);
  });

  it("refuses when the requester lost Manage Server since planning", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    ctx.mcp.managers.delete(USER);
    expect(await click(ctx, run.id)).toMatchObject({ done: false, text: expect.stringMatching(/Manage Server/) });
    expect(writes(ctx)).toHaveLength(0);
  });

  it("never acts on a run from another server's button", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    expect(await click(ctx, run.id, { guildId: OTHER_GUILD })).toEqual({ text: "I can't find that plan anymore.", done: true });
    expect(writes(ctx)).toHaveLength(0);
    expect((await ctx.store.getRun(run.id))!.status).toBe("awaiting_approval");
  });

  it("needs DELETE typed for plans that delete things", async () => {
    const ctx = await setup([proposePlan([DELETE_STEP])]);
    const { run, post } = await planned(ctx);
    expect(post.buttons).toBe(`confirm:${run.id},cancel:${run.id}`);
    expect(post.content).toMatch(/type DELETE/);
    expect(await click(ctx, run.id)).toMatchObject({ done: false, text: expect.stringMatching(/Type DELETE/) });
    expect(await click(ctx, run.id, { confirmation: "delete" })).toMatchObject({ done: false });
    expect(writes(ctx)).toHaveLength(0);
    expect(await click(ctx, run.id, { confirmation: "DELETE" })).toMatchObject({ done: true });
    await vi.waitFor(() => expect(writes(ctx).map((c) => c.name)).toEqual(["delete_channel"]));
  });

  it("cancels without changing anything", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    expect(await click(ctx, run.id, { action: "cancel" })).toEqual({ text: "Cancelled. Nothing was changed.", done: true });
    expect((await ctx.store.getRun(run.id))!.status).toBe("cancelled");
    expect(await click(ctx, run.id)).toMatchObject({ done: true, text: expect.stringMatching(/isn't waiting/) });
    expect(writes(ctx)).toHaveLength(0);
  });
});

describe("Discord chat: webhook", () => {
  it("requires the shared secret for mentions and buttons", async () => {
    const ctx = await setup();
    const res = await ctx.app.inject({ method: "POST", url: "/internal/discord-events", payload: mention() });
    expect(res.statusCode).toBe(401);
    const res2 = await ctx.app.inject({
      method: "POST", url: "/internal/discord-events", headers: { authorization: "Bearer wrong" },
      payload: { type: "interaction", action: "approve", runId: "00000000-0000-4000-8000-000000000000", guildId: GUILD, channelId: CHANNEL, userId: USER },
    });
    expect(res2.statusCode).toBe(401);
    expect(runsOf(ctx)).toHaveLength(0);
  });

  it("answers button presses as plain text with a done header", async () => {
    const ctx = await setup();
    const { run } = await planned(ctx);
    const res = await ctx.app.inject({
      method: "POST", url: "/internal/discord-events", headers: { authorization: `Bearer ${SECRET}` },
      payload: { type: "interaction", action: "cancel", runId: run.id, guildId: GUILD, channelId: CHANNEL, messageId: null, userId: USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-whispcord-done"]).toBe("1");
    expect(res.body).toBe("Cancelled. Nothing was changed.");
  });

  it("accepts a forwarded mention and starts planning", async () => {
    const ctx = await setup();
    const res = await ctx.app.inject({ method: "POST", url: "/internal/discord-events", headers: { authorization: `Bearer ${SECRET}` }, payload: mention() });
    expect(res.json()).toEqual({ ok: true, handled: true });
    await vi.waitFor(() => expect(lastPost(ctx)?.buttons).toBeTruthy());
  });
});

describe("formatPlan", () => {
  it("fits long plans in one Discord message", () => {
    const steps = Array.from({ length: 100 }, (_, i) => ({
      id: `s${i}`, tool: "create_text_channel", args: {}, reason: `Create channel number ${i} with a fairly long explanation`, risk: "low" as const,
      tier: "build", group: "channels", destructive: false, undoable: true, dependsOn: [],
    }));
    const text = formatPlan({ summary: "Lots", steps, requiresConfirmation: false, confirmationPhrase: null, warnings: [] }, "https://x/servers/1");
    expect(text.length).toBeLessThanOrEqual(1950);
    expect(text).toMatch(/more step\(s\)\. See them all at https:\/\/x\/servers\/1/);
  });
});
