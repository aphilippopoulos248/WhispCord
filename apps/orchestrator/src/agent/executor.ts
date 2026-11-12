import { substitutePlaceholders, toolSpec, type ActionStatus, type ValidatedPlan } from "@whispcord/shared";
import { GatewayError, type GuildGateway } from "../gateway/gateway.js";
import type { RunAction, Store } from "../store/types.js";
import { beforeSnapshotCall, buildInverse } from "./inverses.js";

export interface StepEvent {
  stepId: string;
  status: ActionStatus;
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface ExecuteResult {
  ok: boolean;
  failedStepId: string | null;
  error: string | null;
}

/**
 * Runs approved steps in order through the gateway. Stops at the first failure so the user can
 * retry, ask Whispcord to fix it, or undo what ran. Already-succeeded steps (from an earlier
 * attempt of the same run) are skipped, which is what makes "Retry failed step" work.
 */
export async function executePlan(input: {
  runId: string;
  plan: ValidatedPlan;
  approvedStepIds: string[];
  gateway: GuildGateway;
  store: Store;
  onStep?: (e: StepEvent) => void;
}): Promise<ExecuteResult> {
  const { runId, plan, gateway, store, onStep } = input;
  const approved = new Set(input.approvedStepIds);
  const existing = new Map<string, RunAction>((await store.listActions(runId)).map((a) => [a.stepId, a]));
  const createdIds: Record<string, string> = {};
  for (const a of existing.values()) {
    if (a.status === "succeeded" && a.createdObjectId) {
      createdIds[a.stepId] = a.createdObjectId;
      if (a.createdObjectType) gateway.registerCreated(a.createdObjectType, a.createdObjectId);
    }
  }

  for (const [index, step] of plan.steps.entries()) {
    const prior = existing.get(step.id);
    if (prior?.status === "succeeded") continue;

    if (!approved.has(step.id)) {
      if (!prior) {
        await store.insertAction(blankAction(runId, step.id, index, step.tool, {}, "skipped", "Not approved"));
      }
      onStep?.({ stepId: step.id, status: "skipped" });
      continue;
    }

    const missingDep = step.dependsOn.find((d) => !createdIds[d]);
    if (missingDep) {
      const error = `Depends on step ${missingDep}, which did not run.`;
      await upsertAction(store, prior, blankAction(runId, step.id, index, step.tool, {}, "skipped", error));
      onStep?.({ stepId: step.id, status: "skipped", error });
      continue;
    }

    let args: Record<string, string>;
    try {
      args = substitutePlaceholders(step.args, createdIds);
    } catch (err) {
      return fail(store, prior, runId, step.id, index, step.tool, {}, (err as Error).message, onStep);
    }

    onStep?.({ stepId: step.id, status: "running" });
    const action = await upsertAction(store, prior, blankAction(runId, step.id, index, step.tool, args, "running", null));

    // Capture before-state for edits so Undo can restore it.
    let before: string | null = null;
    const snap = beforeSnapshotCall(step.tool, args);
    if (snap) {
      try {
        const res = await gateway.call(snap.tool, snap.args);
        before = res.isError ? null : res.text;
      } catch {
        before = null;
      }
    }

    const started = Date.now();
    try {
      const res = await gateway.call(step.tool, args);
      const durationMs = Date.now() - started;
      if (res.isError) {
        await store.updateAction(action.id, { status: "failed", error: res.text, resultText: res.text, durationMs, beforeSnapshot: before });
        onStep?.({ stepId: step.id, status: "failed", error: explainDiscordError(res.text), durationMs });
        return { ok: false, failedStepId: step.id, error: explainDiscordError(res.text) };
      }
      if (res.createdId) createdIds[step.id] = res.createdId;
      const inverse = buildInverse({ tool: step.tool, args, createdId: res.createdId, before, snapshot: gateway.snapshot });
      await store.updateAction(action.id, {
        status: "succeeded",
        resultText: res.text,
        durationMs,
        createdObjectId: res.createdId,
        createdObjectType: res.createdId ? toolSpec(step.tool)?.creates ?? null : null,
        beforeSnapshot: before,
        inverseAction: inverse,
      });
      onStep?.({ stepId: step.id, status: "succeeded", result: res.text, durationMs });
    } catch (err) {
      const msg = err instanceof GatewayError ? err.message : `Unexpected error: ${(err as Error).message}`;
      await store.updateAction(action.id, { status: "failed", error: msg, durationMs: Date.now() - started });
      onStep?.({ stepId: step.id, status: "failed", error: msg });
      return { ok: false, failedStepId: step.id, error: msg };
    }
  }
  return { ok: true, failedStepId: null, error: null };
}

function blankAction(
  runId: string, stepId: string, stepIndex: number, tool: string, args: Record<string, string>,
  status: ActionStatus, error: string | null,
): Omit<RunAction, "id"> {
  return {
    runId, stepId, stepIndex, tool, args, status, error, resultText: null, createdObjectId: null,
    createdObjectType: null, beforeSnapshot: null, inverseAction: null, durationMs: null,
  };
}

async function upsertAction(store: Store, prior: RunAction | undefined, value: Omit<RunAction, "id">): Promise<RunAction> {
  if (prior) {
    await store.updateAction(prior.id, value);
    return { ...prior, ...value };
  }
  return store.insertAction(value);
}

async function fail(
  store: Store, prior: RunAction | undefined, runId: string, stepId: string, index: number, tool: string,
  args: Record<string, string>, error: string, onStep?: (e: StepEvent) => void,
): Promise<ExecuteResult> {
  await upsertAction(store, prior, blankAction(runId, stepId, index, tool, args, "failed", error));
  onStep?.({ stepId, status: "failed", error });
  return { ok: false, failedStepId: stepId, error };
}

/** Turns common Discord/JDA errors into something a server owner can act on. */
export function explainDiscordError(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("hierarchy") || t.includes("higher or equal") || t.includes("can't modify a role with higher")) {
    return `${text}\n\nThe Whispcord role must sit above any role it manages. In Server Settings → Roles, drag "Whispcord" near the top.`;
  }
  if (t.includes("missing permission") || t.includes("insufficientpermission") || t.includes("missing access")) {
    return `${text}\n\nWhispcord's bot role is missing a permission for this. Check the role's permissions, or re-add the bot from the server page.`;
  }
  return text;
}
