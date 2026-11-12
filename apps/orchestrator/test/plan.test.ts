import { describe, expect, it } from "vitest";
import { executePlan } from "../src/agent/executor.js";
import { PlanValidationError, validatePlan } from "../src/agent/validatePlan.js";
import { extractCreatedId, parseChannelInfo, parseOverwrites } from "../src/gateway/results.js";
import { normalizeToolText } from "../src/mcp/client.js";
import { MemoryStore } from "../src/store/memory.js";
import { CAT, GENERAL, OTHER_GUILD_CHANNEL, ROLE_MOD, makeGateway } from "./fakes.js";

const limits = { maxToolCalls: 60, maxCreations: 50, maxDeletions: 2 };
const opts = { confirmationPhrase: "DELETE" };

const gamingPlan = {
  summary: "Gaming area",
  steps: [
    { id: "s1", tool: "create_category", args: { name: "Gaming" }, reason: "container", risk: "low" },
    { id: "s2", tool: "create_text_channel", args: { name: "clips", categoryId: "{{s1.id}}" }, reason: "", risk: "low" },
    { id: "s3", tool: "create_voice_channel", args: { name: "Squad", categoryId: "{{s1.id}}" }, reason: "", risk: "low" },
    { id: "s4", tool: "create_role", args: { name: "Moderator" }, reason: "", risk: "medium" },
    { id: "s5", tool: "upsert_role_channel_permissions", args: { channelId: "{{s2.id}}", roleId: "{{s4.id}}", allowRaw: "1024" }, reason: "", risk: "medium" },
  ],
};

async function problems(plan: unknown, l = limits) {
  const { gateway } = makeGateway();
  try {
    await validatePlan(plan, gateway, l, opts);
    return [];
  } catch (e) {
    if (e instanceof PlanValidationError) return e.problems;
    throw e;
  }
}

describe("validatePlan", () => {
  it("accepts a valid plan with placeholders and records dependencies", async () => {
    const { gateway } = makeGateway();
    const plan = await validatePlan(gamingPlan, gateway, limits, opts);
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.steps.find((s) => s.id === "s5")!.dependsOn.sort()).toEqual(["s2", "s4"]);
  });

  it("rejects unknown tools, foreign IDs and bad placeholders", async () => {
    const p = await problems({
      summary: "bad",
      steps: [
        { id: "s1", tool: "nuke_server", args: {}, reason: "", risk: "high" },
        { id: "s2", tool: "edit_text_channel", args: { channelId: OTHER_GUILD_CHANNEL, name: "x" }, reason: "", risk: "low" },
        { id: "s3", tool: "create_text_channel", args: { name: "x", categoryId: "{{s9.id}}" }, reason: "", risk: "low" },
        { id: "s4", tool: "list_channels", args: {}, reason: "", risk: "low" },
        { id: "s5", tool: "create_text_channel", args: { name: "x", categoryId: "{{s4.id}}" }, reason: "", risk: "low" },
      ],
    });
    expect(p.join("\n")).toMatch(/nuke_server/);
    expect(p.join("\n")).toMatch(/not part of this server/);
    expect(p.join("\n")).toMatch(/s9/);
    expect(p.join("\n")).toMatch(/does not create anything/);
  });

  it("rejects too many deletions and flags destructive plans", async () => {
    const del = (id: string, channelId: string) => ({ id, tool: "delete_channel", args: { channelId }, reason: "", risk: "high" });
    expect((await problems({ summary: "", steps: [del("s1", GENERAL), del("s2", GENERAL), del("s3", GENERAL)] })).join()).toMatch(/deletes 3/);
    const { gateway } = makeGateway();
    const plan = await validatePlan({ summary: "", steps: [del("s1", GENERAL)] }, gateway, limits, opts);
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.confirmationPhrase).toBe("DELETE");
  });

  it("rejects duplicate step ids and malformed plans", async () => {
    expect((await problems({ summary: "", steps: [gamingPlan.steps[0], gamingPlan.steps[0]] })).join()).toMatch(/duplicate/);
    expect((await problems({ steps: "nope" })).length).toBeGreaterThan(0);
  });
});

describe("executePlan", () => {
  it("runs steps in order, substitutes placeholders and records inverses", async () => {
    const { gateway, mcp } = makeGateway();
    const plan = await validatePlan(gamingPlan, gateway, limits, opts);
    const store = new MemoryStore();
    const run = await store.createRun({ serverId: "x", profileId: "p", kind: "prompt", prompt: "", model: "m" });
    const res = await executePlan({ runId: run.id, plan, approvedStepIds: plan.steps.map((s) => s.id), gateway, store });
    expect(res.ok).toBe(true);

    const actions = await store.listActions(run.id);
    const cat = actions.find((a) => a.stepId === "s1")!;
    const clips = actions.find((a) => a.stepId === "s2")!;
    expect(clips.args.categoryId).toBe(cat.createdObjectId);
    expect(cat.inverseAction).toEqual({ tool: "delete_category", args: { categoryId: cat.createdObjectId } });
    // Permission overwrite on a fresh channel: before-state had a Moderator overwrite in the fake.
    const perm = actions.find((a) => a.stepId === "s5")!;
    expect(perm.beforeSnapshot).toContain("Allow: 1024");
    expect(mcp.calls.some((c) => c.name === "list_channel_permission_overwrites")).toBe(true);
  });

  it("stops at the first failure and resumes on retry", async () => {
    const mcp = new (await import("./fakes.js")).FakeMcp();
    mcp.failOn.add("create_role");
    const { gateway } = makeGateway({ mcp });
    const plan = await validatePlan(gamingPlan, gateway, limits, opts);
    const store = new MemoryStore();
    const run = await store.createRun({ serverId: "x", profileId: "p", kind: "prompt", prompt: "", model: "m" });
    const all = plan.steps.map((s) => s.id);
    const first = await executePlan({ runId: run.id, plan, approvedStepIds: all, gateway, store });
    expect(first.ok).toBe(false);
    expect(first.failedStepId).toBe("s4");
    expect(first.error).toMatch(/drag "Whispcord"/);

    mcp.failOn.clear();
    const before = mcp.calls.filter((c) => c.name === "create_category").length;
    const second = await executePlan({ runId: run.id, plan, approvedStepIds: all, gateway, store });
    expect(second.ok).toBe(true);
    expect(mcp.calls.filter((c) => c.name === "create_category").length).toBe(before); // not repeated
  });

  it("skips steps whose dependencies were unticked", async () => {
    const { gateway } = makeGateway();
    const plan = await validatePlan(gamingPlan, gateway, limits, opts);
    const store = new MemoryStore();
    const run = await store.createRun({ serverId: "x", profileId: "p", kind: "prompt", prompt: "", model: "m" });
    await executePlan({ runId: run.id, plan, approvedStepIds: ["s2", "s4"], gateway, store });
    const s2 = (await store.listActions(run.id)).find((a) => a.stepId === "s2")!;
    expect(s2.status).toBe("skipped");
  });
});

describe("result parsing", () => {
  it("unwraps the JSON-encoded strings Spring AI returns (seen live), leaving JSON objects alone", () => {
    // Exact shape observed from a real discord-mcp on 2026-11-12.
    const raw = JSON.stringify("Type: TEXT\nName: general\nID: 1570282869048483964\nPosition: 0\n");
    expect(raw.startsWith('"')).toBe(true);
    const text = normalizeToolText(raw);
    expect(text).toContain("\n");
    expect(parseChannelInfo(text)).toMatchObject({ Name: "general", Position: "0" });
    const json = '{"guildId":"1","inGuild":true}';
    expect(normalizeToolText(json)).toBe(json);
    expect(normalizeToolText("plain text")).toBe("plain text");
    expect(normalizeToolText('"unterminated')).toBe('"unterminated');
  });

  it("extracts created IDs from discord-mcp responses", () => {
    expect(extractCreatedId("create_text_channel", "Created text channel: clips (ID: 123456789012345678)")).toBe("123456789012345678");
    expect(extractCreatedId("create_webhook", "Created hook webhook: https://discord.com/api/webhooks/123456789012345678/abc")).toBe("123456789012345678");
    expect(extractCreatedId("create_invite", "Created invite: https://discord.gg/AbC12\n • Channel")).toBe("AbC12");
  });

  it("parses permission overwrites", () => {
    const text = `Retrieved 1 permission overwrites:\n- **Role: Moderator** (ID: ${ROLE_MOD})\n  • Allow: 1024 (View Channel)\n  • Deny: 2048 (Send Messages)`;
    expect(parseOverwrites(text)).toEqual([{ type: "role", id: ROLE_MOD, allow: "1024", deny: "2048" }]);
  });

  it("keeps the snapshot category id usable", () => {
    expect(CAT).toMatch(/^\d+$/);
  });
});
