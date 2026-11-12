import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { initialConversation, runPlanner, SYSTEM_PROMPT } from "../src/agent/planner.js";
import { CAT, makeGateway } from "./fakes.js";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Fake Claude: replays scripted responses and records every request it receives. */
function fakeClaude(responses: Array<{ content: unknown[]; usage?: Partial<Anthropic.Beta.Messages.BetaUsage> }>) {
  const requests: Params[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        create: async (params: Params) => {
          requests.push(structuredClone(params));
          const r = responses[Math.min(i++, responses.length - 1)]!;
          const hasTool = r.content.some((b) => (b as { type: string }).type === "tool_use");
          return {
            content: r.content,
            stop_reason: hasTool ? "tool_use" : "end_turn",
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...r.usage },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const limits = { maxToolCalls: 60, maxCreations: 50, maxDeletions: 2 };

function deps(anthropic: Anthropic) {
  const { gateway } = makeGateway();
  return { anthropic, model: "claude-sonnet-5-5", effort: "medium" as const, gateway, limits, confirmationPhrase: "DELETE" };
}

describe("planner", () => {
  it("caches tools + system explicitly and the conversation automatically", async () => {
    const plan = { summary: "x", steps: [{ id: "s1", tool: "create_text_channel", args: { name: "clips", categoryId: CAT }, reason: "", risk: "low" }] };
    const { client, requests } = fakeClaude([{ content: [{ type: "tool_use", id: "t1", name: "propose_plan", input: plan }] }]);
    const d = deps(client);
    await runPlanner(d, initialConversation(d.gateway, "add clips"));
    const req = requests[0]!;
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  });

  it("keeps the cached prefix byte-identical between turns", async () => {
    const plan = { summary: "x", steps: [{ id: "s1", tool: "create_category", args: { name: "Gaming" }, reason: "", risk: "low" }] };
    const { client, requests } = fakeClaude([
      { content: [{ type: "tool_use", id: "t1", name: "list_channels", input: {} }] },
      { content: [{ type: "tool_use", id: "t2", name: "propose_plan", input: plan }], usage: { cache_read_input_tokens: 900 } },
    ]);
    const d = deps(client);
    const result = await runPlanner(d, initialConversation(d.gateway, "add gaming"));
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]!.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect(JSON.stringify(requests[1]!.system)).toBe(JSON.stringify(requests[0]!.system));
    // Turn 2 only appends to turn 1's messages, so the automatic breakpoint can read turn 1.
    expect(JSON.stringify(requests[1]!.messages.slice(0, requests[0]!.messages.length))).toBe(JSON.stringify(requests[0]!.messages));
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 900 });
    expect(result.outcome.kind).toBe("plan");
  });

  it("lists allowed write actions for Claude, never blocked ones", () => {
    const { gateway } = makeGateway();
    const first = initialConversation(gateway, "x")[0]!.content as Array<{ text: string }>;
    const catalog = first[0]!.text;
    expect(catalog).toContain("<available_actions>");
    expect(catalog).toContain("- upsert_role_channel_permissions [build]");
    expect(catalog).toContain("roleId (required)");
    expect(catalog).not.toContain("send_private_message");
    expect(catalog).not.toContain("guildId:");
  });

  it("sends invalid plans back to Claude with the problems", async () => {
    const bad = { summary: "x", steps: [{ id: "s1", tool: "nuke_server", args: {}, reason: "", risk: "high" }] };
    const good = { summary: "x", steps: [{ id: "s1", tool: "create_category", args: { name: "A" }, reason: "", risk: "low" }] };
    const { client, requests } = fakeClaude([
      { content: [{ type: "tool_use", id: "t1", name: "propose_plan", input: bad }] },
      { content: [{ type: "tool_use", id: "t2", name: "propose_plan", input: good }] },
    ]);
    const d = deps(client);
    const result = await runPlanner(d, initialConversation(d.gateway, "x"));
    const feedback = requests[1]!.messages.at(-1)!.content as Array<{ type: string; is_error?: boolean; content: string }>;
    expect(feedback[0]).toMatchObject({ type: "tool_result", is_error: true });
    expect(feedback[0]!.content).toContain("nuke_server");
    expect(result.outcome.kind).toBe("plan");
  });
});
