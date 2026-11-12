import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { findMessages, summarizeForPlanner } from "../src/agent/messageFinder.js";
import { initialConversation, renderActionCatalog, runPlanner } from "../src/agent/planner.js";
import { PlanValidationError, validatePlan } from "../src/agent/validatePlan.js";
import { loadConfig } from "../src/config.js";
import { GatewayError } from "../src/gateway/gateway.js";
import { WhispcordInternal } from "../src/mcp/client.js";
import { RunEvents } from "../src/runs/events.js";
import { RunService } from "../src/runs/service.js";
import { MemoryStore } from "../src/store/memory.js";
import { FakeMcp, GENERAL, GUILD, OTHER_GUILD_CHANNEL, USER, makeGateway } from "./fakes.js";

const SEARCH_TIERS = ["read", "build", "destructive", "message_search"] as const;
const limits = { maxToolCalls: 60, maxCreations: 50, maxDeletions: 10 };

type ParseParams = { messages: Array<{ content: string }> };

/**
 * Fake Claude. `classify` decides which message texts match (by substring), mimicking the
 * Haiku classifier; `plannerTurns` scripts the planner's tool calls.
 */
function fakeClaude(opts: {
  classify?: (text: string) => "low" | "medium" | "high" | null;
  refuse?: boolean;
  plannerTurns?: unknown[][];
}) {
  const classifierInputs: string[] = [];
  const plannerRequests: Array<{ tools: Array<{ name: string }>; messages: unknown[] }> = [];
  let turn = 0;
  const client = {
    messages: {
      parse: async (params: ParseParams) => {
        const content = params.messages[0]!.content;
        classifierInputs.push(content);
        if (opts.refuse) return { stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 10, output_tokens: 0 } };
        const lines = content.split("\n").filter((l) => l.startsWith("{"));
        const matches = lines
          .map((l) => JSON.parse(l) as { i: number; text: string })
          .map((m) => ({ i: m.i, severity: opts.classify?.(m.text) ?? null }))
          .filter((m) => m.severity)
          .map((m) => ({ ...m, reason: "Insults a group of people" }));
        // Also return an index outside this batch, which must be ignored.
        matches.push({ i: 999, severity: "high", reason: "out of batch" });
        return { stop_reason: "end_turn", parsed_output: { matches }, usage: { input_tokens: 100, output_tokens: 20 } };
      },
    },
    beta: {
      messages: {
        create: async (params: { tools: Array<{ name: string }>; messages: unknown[] }) => {
          plannerRequests.push(structuredClone(params));
          const content = opts.plannerTurns?.[Math.min(turn++, (opts.plannerTurns?.length ?? 1) - 1)] ?? [];
          return {
            content,
            stop_reason: content.some((b) => (b as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
            usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, classifierInputs, plannerRequests };
}

const hateful = (t: string) => (t.includes("worthless trash") ? "high" : null);

describe("message search: tier and gateway rules", () => {
  it("is off unless the server enables message_search", async () => {
    const { gateway } = makeGateway();
    await expect(gateway.call("scan_messages", {})).rejects.toMatchObject({ code: "tool_blocked" });
    const on = makeGateway({ enabledTiers: [...SEARCH_TIERS] }).gateway;
    expect((await on.call("scan_messages", {})).isError).toBe(false);
  });

  it("never exposes scan_messages to Claude directly, in the catalog or as a plan step", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    expect(gateway.claudeTools(["read"]).map((t) => t.name)).not.toContain("scan_messages");
    expect(renderActionCatalog(gateway)).not.toContain("scan_messages");
    await expect(
      validatePlan({ summary: "x", steps: [{ id: "s1", tool: "scan_messages", args: {}, reason: "", risk: "low" }] }, gateway, limits, { confirmationPhrase: "DELETE" }),
    ).rejects.toThrow(PlanValidationError);
  });

  it("rejects channel lists that include another server's channel", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    await expect(gateway.call("scan_messages", { channelIds: `${GENERAL},${OTHER_GUILD_CHANNEL}` })).rejects.toMatchObject({ code: "foreign_id" });
  });

  it("treats deleting a message like any other deletion (typed confirmation)", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    await expect(gateway.call("delete_message", { channelId: GENERAL, messageId: "800000000000000003" })).rejects.toMatchObject({ code: "confirmation_required" });
  });
});

describe("message search: finder", () => {
  it("finds matches, keeps excerpts for the admin, and never shows message text to the planner", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    const { client, classifierInputs } = fakeClaude({ classify: hateful });
    const result = await findMessages({ gateway, anthropic: client, model: "claude-haiku-5-5", budget: { remaining: 1000 } }, { criteria: "hateful messages" });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ messageId: "800000000000000003", severity: "high", authorName: "troll", ref: "f1" });
    expect(result.findings[0]!.excerpt).toContain("worthless trash");
    // The classifier saw the text (including the injection attempt) ...
    expect(classifierInputs.join()).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    // ... the planner sees neither the hateful text nor the injection.
    const forPlanner = summarizeForPlanner(result);
    expect(forPlanner).not.toContain("worthless trash");
    expect(forPlanner).not.toContain("IGNORE ALL");
    expect(forPlanner).toContain("800000000000000003");
  });

  it("explains when Discord hides message text (no Message Content intent) without calling Claude", async () => {
    const mcp = new FakeMcp();
    mcp.scanContentAvailable = false;
    const { gateway } = makeGateway({ mcp, enabledTiers: [...SEARCH_TIERS] });
    const { client, classifierInputs } = fakeClaude({ classify: hateful });
    const result = await findMessages({ gateway, anthropic: client, model: "m", budget: { remaining: 1000 } }, { criteria: "hateful" });
    expect(classifierInputs).toHaveLength(0);
    expect(result.stats.contentAvailable).toBe(false);
    expect(summarizeForPlanner(result)).toContain("Message Content intent");
  });

  it("counts refused batches instead of failing", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    const { client } = fakeClaude({ refuse: true });
    const result = await findMessages({ gateway, anthropic: client, model: "m", budget: { remaining: 1000 }, batchSize: 2 }, { criteria: "hateful" });
    expect(result.findings).toHaveLength(0);
    expect(result.stats.unclassifiedBatches).toBe(2);
  });

  it("enforces the per-run message budget", async () => {
    const { gateway, mcp } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    const budget = { remaining: 2 };
    const { client } = fakeClaude({ classify: hateful });
    await findMessages({ gateway, anthropic: client, model: "m", budget }, { criteria: "hateful" });
    expect(mcp.calls.find((c) => c.name === "scan_messages")!.args.maxTotal).toBe("2");
    expect(budget.remaining).toBe(0);
    await expect(findMessages({ gateway, anthropic: client, model: "m", budget }, { criteria: "hateful" })).rejects.toBeInstanceOf(GatewayError);
  });
});

describe("message search: planner and run", () => {
  it("only offers find_messages when message search is available, and can end with a report", async () => {
    const { gateway } = makeGateway({ enabledTiers: [...SEARCH_TIERS] });
    const { client, plannerRequests } = fakeClaude({
      plannerTurns: [[{ type: "tool_use", id: "t1", name: "report_findings", input: { summary: "Nothing needed." } }]],
    });
    const base = { anthropic: client, model: "m", effort: "medium" as const, gateway, limits, confirmationPhrase: "DELETE" };
    const without = await runPlanner(base, initialConversation(gateway, "x"));
    expect(plannerRequests[0]!.tools.map((t) => t.name)).not.toContain("find_messages");
    expect(without.outcome).toEqual({ kind: "report", summary: "Nothing needed." });

    await runPlanner({ ...base, findMessages: async () => "{}" }, initialConversation(gateway, "x"));
    expect(plannerRequests[1]!.tools.map((t) => t.name)).toContain("find_messages");
  });

  it("runs a full search: findings saved on the run, report shown, nothing changed", async () => {
    const config = loadConfig({ RECONCILE_INTERVAL_MINUTES: "0" } as NodeJS.ProcessEnv);
    const store = new MemoryStore();
    store.addProfile({ id: "p1", authUserId: "u1", discordUserId: USER, username: "owner", manageableGuilds: [] });
    const server = await store.upsertConnectedServer({ guildId: GUILD, name: "Test", icon: null, profileId: "p1", botRoleOk: true });
    await store.updateServer(GUILD, { enabledTiers: [...SEARCH_TIERS] });
    const mcp = new FakeMcp();
    const { client, plannerRequests } = fakeClaude({
      classify: hateful,
      plannerTurns: [
        [{ type: "tool_use", id: "t1", name: "find_messages", input: { criteria: "hateful messages" } }],
        [{ type: "tool_use", id: "t2", name: "report_findings", input: { summary: "Found 1 hateful message by troll in #general." } }],
      ],
    });
    const events = new RunEvents();
    const runs = new RunService({ store, mcp, internal: new WhispcordInternal(mcp), anthropic: client, events, config });

    const profile = (await store.getProfileByAuthUser("u1"))!;
    const run = await runs.startRun((await store.getServerByGuildId(GUILD))!, profile, "find hateful messages");
    await new Promise<void>((resolve) => events.subscribe(run.id, (e) => e.type === "done" && resolve()));

    const done = (await store.getRun(run.id))!;
    expect(done.status).toBe("done");
    expect(done.report).toContain("Found 1 hateful message");
    expect(done.messageSearch?.findings.map((f) => f.messageId)).toEqual(["800000000000000003"]);
    expect(done.messageSearch?.searches[0]).toMatchObject({ scanned: 3, criteria: "hateful messages" });
    // The planner's second request carried the tool result: IDs and reason, not the text.
    const toolResult = JSON.stringify(plannerRequests[1]!.messages.at(-1));
    expect(toolResult).toContain("800000000000000003");
    expect(toolResult).not.toContain("worthless trash");
    expect(mcp.calls.some((c) => c.name.startsWith("delete_") || c.name.startsWith("create_"))).toBe(false);
    expect(server.id).toBeTruthy();
  });
});
