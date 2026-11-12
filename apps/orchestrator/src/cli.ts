/**
 * M1 proof of concept: run a prompt against a test server through the full gateway, from the
 * terminal, with no database or web app.
 *
 *   npm run cli -- --guild <serverId> --user <yourDiscordUserId> "Create a Gaming category with ..."
 */
import "./nodeVersion.js";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_ENABLED_TIERS, type Tier } from "@whispcord/shared";
import { executePlan } from "./agent/executor.js";
import { answerConversation, initialConversation, runPlanner } from "./agent/planner.js";
import { loadConfig } from "./config.js";
import { GuildGateway } from "./gateway/gateway.js";
import { McpDiscordClient, WhispcordInternal } from "./mcp/client.js";
import { CONFIRMATION_PHRASE } from "./runs/service.js";
import { MemoryStore } from "./store/memory.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    guild: { type: "string" },
    user: { type: "string" },
    tiers: { type: "string" },
    yes: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const config = loadConfig();
const prompt = positionals.join(" ").trim();
if (!values.guild || !values.user || !prompt) {
  console.error('Usage: npm run cli -- --guild <serverId> --user <yourDiscordUserId> [--tiers build,destructive] [--dry-run] "<prompt>"');
  process.exit(2);
}
if (!config.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY in the repo-root .env");
  process.exit(2);
}

const mcp = new McpDiscordClient(config.DISCORD_MCP_URL, config.WHISPCORD_MCP_SECRET);
const internal = new WhispcordInternal(mcp);
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const rl = createInterface({ input: process.stdin, output: process.stdout });
let inputClosed = false;
rl.on("close", () => {
  inputClosed = true;
});
/** Asks a question; closed or piped-out input counts as an empty answer ("no"). */
async function ask(question: string): Promise<string> {
  if (inputClosed) return "";
  try {
    return await rl.question(question);
  } catch {
    return "";
  }
}
const limits = {
  maxToolCalls: config.MAX_TOOL_CALLS_PER_RUN,
  maxCreations: config.MAX_CREATIONS_PER_RUN,
  maxDeletions: config.MAX_DELETIONS_PER_RUN,
};
const tiers: Tier[] = values.tiers ? ["read", ...(values.tiers.split(",") as Tier[])] : [...DEFAULT_ENABLED_TIERS];

const bot = await internal.botStatus(values.guild);
if (!bot.inGuild) {
  console.error("The bot is not in that server. Add it with the Builder-tier invite URL first.");
  process.exit(1);
}
const requester = await internal.memberPermissions(values.guild, values.user);
const snapshot = await internal.snapshot(values.guild);
const toolDefs = await mcp.listTools();
const makeGateway = (destructiveConfirmed = false) =>
  new GuildGateway({ mcp, internal, toolDefs, guildId: values.guild!, requester, enabledTiers: tiers, snapshot, limits, destructiveConfirmed });

console.log(`Server: ${snapshot.name} · ${snapshot.channels.length} channels · ${snapshot.roles.length} roles`);
if ((bot.rolesAboveBot ?? 0) > 0) console.log(`⚠ ${bot.rolesAboveBot} role(s) sit above the bot's role; it can't manage those.`);

const planningGateway = makeGateway();
let conversation = initialConversation(planningGateway, prompt);
const deps = {
  anthropic, model: config.WHISPCORD_PLANNER_MODEL, effort: config.WHISPCORD_PLANNER_EFFORT,
  gateway: planningGateway, limits, confirmationPhrase: CONFIRMATION_PHRASE, onLog: (m: string) => console.log(`  … ${m}`),
};

for (;;) {
  console.log("\nPlanning…");
  const result = await runPlanner(deps, conversation);
  const u = result.usage;
  console.log(`  (tokens: ${u.inputTokens} in, ${u.cacheReadTokens} cache read, ${u.cacheWriteTokens} cache write, ${u.outputTokens} out)`);
  const o = result.outcome;
  if (o.kind === "failed") {
    console.error(`\n✗ ${o.error}`);
    process.exit(1);
  }
  if (o.kind === "question") {
    const answer = await ask(`\n? ${o.question}\n> `);
    conversation = answerConversation(result.conversation, answer, o.toolUseId, o.partialResults);
    continue;
  }

  const plan = o.plan;
  console.log(`\nPlan: ${plan.summary}\n`);
  for (const s of plan.steps) {
    const flag = s.destructive ? "🗑 " : s.undoable ? "  " : "· ";
    console.log(`${flag}${s.id}  ${s.tool}  ${JSON.stringify(s.args)}\n      ${s.reason}`);
  }
  for (const w of plan.warnings) console.log(`⚠ ${w}`);

  if (values["dry-run"]) {
    console.log("\nDry run: nothing was changed.");
    process.exit(0);
  }

  let confirmed = false;
  if (plan.requiresConfirmation) {
    const typed = await ask(`\nThis plan deletes things. Type ${plan.confirmationPhrase} to allow it: `);
    confirmed = typed.trim() === plan.confirmationPhrase;
    if (!confirmed) {
      console.log("Not confirmed. Nothing was changed.");
      process.exit(0);
    }
  } else if (!values.yes) {
    const go = await ask("\nRun this plan? [y/N] ");
    if (!/^y(es)?$/i.test(go.trim())) {
      console.log("Cancelled. Nothing was changed.");
      process.exit(0);
    }
  }

  const store = new MemoryStore();
  const run = await store.createRun({ serverId: "cli", profileId: "cli", kind: "prompt", prompt, model: deps.model });
  const exec = await executePlan({
    runId: run.id,
    plan,
    approvedStepIds: plan.steps.map((s) => s.id),
    gateway: makeGateway(confirmed),
    store,
    onStep: (e) => {
      if (e.status === "running") return;
      const icon = e.status === "succeeded" ? "✓" : e.status === "skipped" ? "–" : "✗";
      console.log(`${icon} ${e.stepId} ${e.status}${e.error ? `: ${e.error}` : e.result ? `: ${e.result.split("\n")[0]}` : ""}`);
    },
  });

  const actions = await store.listActions(run.id);
  const undo = actions.filter((a) => a.inverseAction).reverse();
  if (undo.length) {
    console.log("\nTo undo, these actions would run:");
    for (const a of undo) console.log(`  ${a.inverseAction!.tool} ${JSON.stringify(a.inverseAction!.args)}`);
  }
  rl.close();
  process.exit(exec.ok ? 0 : 1);
}
