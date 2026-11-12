import type Anthropic from "@anthropic-ai/sdk";
import type { CreatedObjectType, RunStatus, ValidatedPlan } from "@whispcord/shared";
import { executePlan } from "../agent/executor.js";
import { findMessages, summarizeForPlanner } from "../agent/messageFinder.js";
import { answerConversation, initialConversation, runPlanner, type PlannerResult } from "../agent/planner.js";
import { validatePlan } from "../agent/validatePlan.js";
import type { Config } from "../config.js";
import { GuildGateway, type GatewayLimits } from "../gateway/gateway.js";
import type { DiscordMcp, WhispcordInternal } from "../mcp/client.js";
import type { Profile, Run, RunMessageSearch, Server, Store } from "../store/types.js";
import type { RunEvents } from "./events.js";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const CONFIRMATION_PHRASE = "DELETE";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface RunServiceDeps {
  store: Store;
  mcp: DiscordMcp;
  internal: WhispcordInternal;
  anthropic: Anthropic | null;
  events: RunEvents;
  config: Config;
  log?: (msg: string, extra?: unknown) => void;
}

export class RunService {
  /** One active planning/execution per server at a time. */
  private busy = new Set<string>();

  constructor(private readonly d: RunServiceDeps) {}

  get limits(): GatewayLimits {
    return {
      maxToolCalls: this.d.config.MAX_TOOL_CALLS_PER_RUN,
      maxCreations: this.d.config.MAX_CREATIONS_PER_RUN,
      maxDeletions: this.d.config.MAX_DELETIONS_PER_RUN,
    };
  }

  /** Live permission re-check + fresh snapshot, every time. */
  async buildGateway(
    server: Server,
    profile: Profile,
    opts: { destructiveConfirmed?: boolean; undoMode?: boolean; knownCreated?: Array<{ type: CreatedObjectType; id: string }> } = {},
  ): Promise<GuildGateway> {
    if (server.status !== "connected") throw new HttpError(409, "This server is not connected to Whispcord.");
    const requester = await this.d.internal.memberPermissions(server.guildId, profile.discordUserId);
    if (!requester.botInGuild) {
      await this.d.store.updateServer(server.guildId, { status: "disconnected" });
      throw new HttpError(409, "Whispcord's bot is no longer in this server. Reconnect it from the servers page.");
    }
    if (!requester.canManageServer) {
      throw new HttpError(403, "You need Manage Server on this server to use Whispcord.");
    }
    const [snapshot, toolDefs] = await Promise.all([this.d.internal.snapshot(server.guildId), this.d.mcp.listTools()]);
    return new GuildGateway({
      mcp: this.d.mcp,
      internal: this.d.internal,
      toolDefs,
      guildId: server.guildId,
      requester,
      enabledTiers: server.enabledTiers,
      snapshot,
      limits: this.limits,
      destructiveConfirmed: opts.destructiveConfirmed,
      undoMode: opts.undoMode,
      knownCreated: opts.knownCreated,
    });
  }

  private emitStatus(runId: string, status: RunStatus, message?: string) {
    this.d.events.emit({ type: "status", runId, status, message });
  }

  private async setStatus(run: Run, status: RunStatus, patch: Partial<Run> = {}, message?: string) {
    await this.d.store.updateRun(run.id, { ...patch, status });
    this.emitStatus(run.id, status, message);
    if (["done", "failed", "undone", "cancelled", "awaiting_approval", "needs_input"].includes(status)) {
      this.d.events.emit({ type: "done", runId: run.id, status });
    }
  }

  private lock(guildId: string) {
    if (this.busy.has(guildId)) throw new HttpError(409, "Whispcord is already working on this server. Wait for it to finish.");
    this.busy.add(guildId);
    return () => this.busy.delete(guildId);
  }

  async startRun(server: Server, profile: Profile, prompt: string, kind: Run["kind"] = "prompt", parentRunId: string | null = null): Promise<Run> {
    if (!this.d.anthropic) throw new HttpError(503, "ANTHROPIC_API_KEY is not configured.");
    const trimmed = prompt.trim();
    if (!trimmed) throw new HttpError(400, "Prompt is empty.");
    if (trimmed.length > 4000) throw new HttpError(400, "Prompt is too long (max 4000 characters).");
    const since = new Date(Date.now() - 60 * 60 * 1000);
    if ((await this.d.store.countRunsSince(server.id, since)) >= this.d.config.MAX_RUNS_PER_SERVER_PER_HOUR) {
      throw new HttpError(429, "This server has hit its hourly run limit. Try again later.");
    }
    if ((await this.d.store.countRunsByProfileSince(profile.id, since)) >= this.d.config.MAX_RUNS_PER_USER_PER_HOUR) {
      throw new HttpError(429, "You've hit your hourly run limit. Try again later.");
    }
    // Fail fast on permissions before creating a run row.
    const gateway = await this.buildGateway(server, profile);
    const run = await this.d.store.createRun({
      serverId: server.id, profileId: profile.id, kind, parentRunId, prompt: trimmed, model: this.d.config.WHISPCORD_PLANNER_MODEL,
    });
    await this.d.store.recordUsage(profile.id, { runs: 1 });
    void this.plan(run, server, profile, initialConversation(gateway, trimmed), gateway);
    return run;
  }

  async answer(run: Run, server: Server, profile: Profile, answer: string): Promise<void> {
    if (run.status !== "needs_input" || !run.pendingQuestion) throw new HttpError(409, "This run is not waiting for an answer.");
    if (!answer.trim()) throw new HttpError(400, "Answer is empty.");
    const conversation = answerConversation(
      (run.conversation ?? []) as BetaMessageParam[],
      answer.trim(),
      run.pendingQuestion.toolUseId,
      run.pendingQuestion.partialResults as ToolResult[],
    );
    await this.d.store.updateRun(run.id, { pendingQuestion: null });
    void this.plan(run, server, profile, conversation);
  }

  private async plan(run: Run, server: Server, profile: Profile, conversation: BetaMessageParam[], gw?: GuildGateway) {
    let release: (() => void) | null = null;
    try {
      release = this.lock(server.guildId);
      await this.setStatus(run, "planning");
      const gateway = gw ?? (await this.buildGateway(server, profile));
      const search = this.messageSearchFor(run, gateway);
      const result: PlannerResult = await runPlanner(
        {
          anthropic: this.d.anthropic!,
          model: this.d.config.WHISPCORD_PLANNER_MODEL,
          effort: this.d.config.WHISPCORD_PLANNER_EFFORT,
          gateway,
          limits: this.limits,
          confirmationPhrase: CONFIRMATION_PHRASE,
          onLog: (message) => this.d.events.emit({ type: "log", runId: run.id, message }),
          findMessages: search?.find,
        },
        conversation,
      );
      const fresh = await this.d.store.getRun(run.id);
      const u = result.usage;
      const tokens = {
        inputTokens: (fresh?.inputTokens ?? 0) + u.inputTokens,
        outputTokens: (fresh?.outputTokens ?? 0) + u.outputTokens,
        cacheReadTokens: (fresh?.cacheReadTokens ?? 0) + u.cacheReadTokens,
        cacheWriteTokens: (fresh?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
      };
      // Usage counts every token processed; the per-run columns keep the cost breakdown.
      await this.d.store.recordUsage(profile.id, { tokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens });
      const o = result.outcome;
      if (o.kind === "plan") {
        await this.d.store.updateRun(run.id, { plan: o.plan, conversation: result.conversation, ...tokens });
        this.d.events.emit({ type: "plan", runId: run.id, plan: o.plan });
        await this.setStatus(run, "awaiting_approval");
      } else if (o.kind === "report") {
        const messageSearch = search?.state() ?? fresh?.messageSearch ?? null;
        await this.d.store.updateRun(run.id, { report: o.summary, messageSearch, conversation: result.conversation, ...tokens });
        this.d.events.emit({ type: "report", runId: run.id, summary: o.summary, findings: messageSearch?.findings ?? [] });
        await this.setStatus(run, "done");
      } else if (o.kind === "question") {
        await this.d.store.updateRun(run.id, {
          conversation: result.conversation,
          pendingQuestion: { toolUseId: o.toolUseId, question: o.question, partialResults: o.partialResults },
          ...tokens,
        });
        this.d.events.emit({ type: "question", runId: run.id, question: o.question });
        await this.setStatus(run, "needs_input");
      } else {
        await this.setStatus(run, "failed", { error: o.error, conversation: result.conversation, ...tokens }, o.error);
      }
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : `Planning failed: ${(err as Error).message}`;
      this.d.log?.("planning failed", err);
      await this.setStatus(run, "failed", { error: msg }, msg);
    } finally {
      release?.();
    }
  }

  /**
   * Message search for one planning pass, if the server enabled it. Results accumulate on the run
   * (refs f1, f2, ... stay unique across searches) and are saved as they arrive.
   */
  private messageSearchFor(run: Run, gateway: GuildGateway) {
    if (!this.d.anthropic || !gateway.allowedToolNames().includes("scan_messages")) return null;
    const state: RunMessageSearch = run.messageSearch
      ? structuredClone(run.messageSearch)
      : { findings: [], searches: [], classifierTokens: { input: 0, output: 0 } };
    const budget = { remaining: this.d.config.MAX_MESSAGES_SCANNED_PER_RUN - state.searches.reduce((n, s) => n + s.scanned, 0) };
    const find = async (input: unknown) => {
      const result = await findMessages({ gateway, anthropic: this.d.anthropic!, model: this.d.config.WHISPCORD_CLASSIFIER_MODEL, budget }, input);
      const known = new Set(state.findings.map((f) => f.messageId));
      const fresh = result.findings.filter((f) => !known.has(f.messageId));
      const renumbered = fresh.map((f, i) => ({ ...f, ref: `f${state.findings.length + i + 1}` }));
      state.findings.push(...renumbered);
      state.searches.push({ ...result.stats, criteria: (input as { criteria?: string }).criteria ?? "" });
      state.classifierTokens.input += result.usage.inputTokens;
      state.classifierTokens.output += result.usage.outputTokens;
      await this.d.store.updateRun(run.id, { messageSearch: state });
      await this.d.store.recordUsage(run.profileId, { tokens: result.usage.inputTokens + result.usage.outputTokens });
      this.d.events.emit({ type: "log", runId: run.id, message: `Checked ${result.stats.scanned} messages, ${renumbered.length} match(es)` });
      return summarizeForPlanner({ ...result, findings: renumbered });
    };
    return { find, state: () => state };
  }

  async approve(run: Run, server: Server, profile: Profile, stepIds: string[], confirmation?: string): Promise<void> {
    if (run.status !== "awaiting_approval" || !run.plan) throw new HttpError(409, "This run has no plan waiting for approval.");
    const plan = run.plan;
    const known = new Set(plan.steps.map((s) => s.id));
    const approved = stepIds.filter((id) => known.has(id));
    if (approved.length === 0) throw new HttpError(400, "Select at least one step to run.");
    for (const step of plan.steps) {
      if (approved.includes(step.id)) {
        const missing = step.dependsOn.filter((d) => !approved.includes(d));
        if (missing.length) throw new HttpError(400, `Step ${step.id} needs step(s) ${missing.join(", ")}, which you unticked.`);
      }
    }
    const destructive = plan.steps.some((s) => s.destructive && approved.includes(s.id));
    if (destructive && run.kind !== "undo" && confirmation !== plan.confirmationPhrase) {
      throw new HttpError(400, `Type ${plan.confirmationPhrase} to confirm the deletions in this plan.`);
    }
    await this.d.store.updateRun(run.id, { approvedStepIds: approved });
    void this.execute({ ...run, approvedStepIds: approved }, server, profile, destructive);
  }

  async retry(run: Run, server: Server, profile: Profile): Promise<void> {
    if (run.status !== "failed" || !run.plan || !run.approvedStepIds) throw new HttpError(409, "Only failed runs that already started can be retried.");
    const destructive = run.plan.steps.some((s) => s.destructive && run.approvedStepIds!.includes(s.id));
    void this.execute(run, server, profile, destructive);
  }

  private async execute(run: Run, server: Server, profile: Profile, destructiveConfirmed: boolean) {
    let release: (() => void) | null = null;
    try {
      release = this.lock(server.guildId);
      await this.setStatus(run, "running");
      const knownCreated = run.kind === "undo" && run.parentRunId ? await this.createdBy(run.parentRunId) : undefined;
      const gateway = await this.buildGateway(server, profile, {
        destructiveConfirmed,
        undoMode: run.kind === "undo",
        knownCreated,
      });
      const result = await executePlan({
        runId: run.id,
        plan: run.plan!,
        approvedStepIds: run.approvedStepIds ?? [],
        gateway,
        store: this.d.store,
        onStep: (e) => this.d.events.emit({ type: "step", runId: run.id, ...e }),
      });
      await this.d.store.recordUsage(profile.id, { actions: gateway.usage.calls });
      if (result.ok) {
        if (run.kind === "undo" && run.parentRunId) {
          await this.d.store.updateRun(run.parentRunId, { status: "undone" });
        }
        await this.setStatus(run, "done");
      } else {
        await this.setStatus(run, "failed", { error: result.error }, result.error ?? undefined);
      }
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : `Run failed: ${(err as Error).message}`;
      this.d.log?.("execution failed", err);
      await this.setStatus(run, "failed", { error: msg }, msg);
    } finally {
      release?.();
    }
  }

  private async createdBy(runId: string) {
    return (await this.d.store.listActions(runId))
      .filter((a) => a.status === "succeeded" && a.createdObjectId && a.createdObjectType)
      .map((a) => ({ type: a.createdObjectType!, id: a.createdObjectId! }));
  }

  /** Builds the inverse plan of a run as a new run awaiting approval. No Claude call needed. */
  async undo(run: Run, server: Server, profile: Profile): Promise<Run> {
    if (!["done", "failed"].includes(run.status)) throw new HttpError(409, "Only finished runs can be undone.");
    if (run.kind === "undo") throw new HttpError(400, "Undo runs can't be undone.");
    const actions = (await this.d.store.listActions(run.id)).filter((a) => a.status === "succeeded");
    const inverses = actions.filter((a) => a.inverseAction).reverse();
    if (inverses.length === 0) throw new HttpError(400, "Nothing in this run can be undone.");
    const notUndoable = actions.length - inverses.length;

    const gateway = await this.buildGateway(server, profile, { undoMode: true, knownCreated: await this.createdBy(run.id) });
    const rawPlan = {
      summary: `Undo of: ${run.prompt.slice(0, 200)}`,
      steps: inverses.map((a, i) => ({
        id: `u${i + 1}`,
        tool: a.inverseAction!.tool,
        args: a.inverseAction!.args,
        reason: `Reverses step ${a.stepId} (${a.tool})`,
        risk: "medium" as const,
      })),
    };
    const plan: ValidatedPlan = await validatePlan(rawPlan, gateway, { ...this.limits, maxDeletions: this.limits.maxCreations }, {
      confirmationPhrase: CONFIRMATION_PHRASE,
    });
    // Undo deletes only what Whispcord created; the gateway enforces that, so no typed phrase.
    plan.requiresConfirmation = false;
    plan.confirmationPhrase = null;
    plan.warnings = plan.warnings.filter((w) => !w.startsWith("Deleted"));
    plan.warnings.push("Undo deletes only what this run created. Messages posted in those channels since then will be lost.");
    if (notUndoable) plan.warnings.push(`${notUndoable} step(s) from the original run can't be undone and are not included.`);

    const undoRun = await this.d.store.createRun({
      serverId: server.id, profileId: profile.id, kind: "undo", parentRunId: run.id, prompt: `Undo: ${run.prompt}`, model: "none",
    });
    await this.d.store.updateRun(undoRun.id, { plan, status: "awaiting_approval" });
    return (await this.d.store.getRun(undoRun.id))!;
  }

  /** "Ask Whispcord to fix": a new run whose prompt carries the failure context. */
  async fix(run: Run, server: Server, profile: Profile): Promise<Run> {
    if (run.status !== "failed") throw new HttpError(409, "Only failed runs can be fixed.");
    const actions = await this.d.store.listActions(run.id);
    const done = actions.filter((a) => a.status === "succeeded").map((a) => `- ${a.stepId} ${a.tool} ✓ ${a.resultText?.split("\n")[0] ?? ""}`);
    const failed = actions.find((a) => a.status === "failed");
    const prompt = [
      `Original request: ${run.prompt}`,
      "",
      "A previous attempt partly ran. These steps already succeeded (do not repeat them):",
      ...(done.length ? done : ["- none"]),
      "",
      failed ? `This step failed: ${failed.tool} ${JSON.stringify(failed.args)}\nError: ${failed.error}` : `The run failed: ${run.error}`,
      "",
      "Propose a plan that finishes the original request from the server's current state.",
    ].join("\n");
    return this.startRun(server, profile, prompt, "fix", run.id);
  }

  async cancel(run: Run): Promise<void> {
    if (!["awaiting_approval", "needs_input"].includes(run.status)) throw new HttpError(409, "Only runs waiting on you can be cancelled.");
    await this.setStatus(run, "cancelled");
  }
}
