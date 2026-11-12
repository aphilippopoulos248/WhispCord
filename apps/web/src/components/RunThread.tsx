"use client";

import type { ActionStatus, RunEvent, RunStatus, ValidatedPlan, ValidatedStep } from "@whispcord/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, subscribeRun } from "@/lib/api";

interface RunDto {
  id: string;
  kind: "prompt" | "undo" | "fix";
  prompt: string;
  status: RunStatus;
  plan: ValidatedPlan | null;
  pendingQuestion: { question: string } | null;
  approvedStepIds: string[] | null;
  error: string | null;
}

interface ActionDto {
  stepId: string;
  status: ActionStatus;
  resultText: string | null;
  error: string | null;
  inverseAction: unknown;
}

const GROUP_ICONS: Record<string, string> = {
  category: "📁", channel: "#", role: "🎭", permission: "🔒", webhook: "🪝", event: "📅",
  invite: "✉️", emoji: "😀", message: "💬", member: "👤", moderation: "🛡", server: "🖥",
};

const FINISHED: RunStatus[] = ["done", "failed", "undone", "cancelled"];

export function RunThread({
  runId,
  onChanged,
  onOpenRun,
}: {
  runId: string;
  onChanged: (id: string, status: string, finished: boolean) => void;
  onOpenRun: (id: string, prompt?: string) => void;
}) {
  const [run, setRun] = useState<RunDto | null>(null);
  const [actions, setActions] = useState<Record<string, ActionDto>>({});
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ run: RunDto; actions: ActionDto[] }>(`/runs/${runId}`);
      setRun(res.run);
      setActions(Object.fromEntries(res.actions.map((a) => [a.stepId, a])));
      if (res.run.plan) {
        setSelected((prev) => (prev.size ? prev : new Set(res.run.approvedStepIds ?? res.run.plan!.steps.map((s) => s.id))));
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    void load();
    return subscribeRun(runId, (e: RunEvent) => {
      if (e.type === "log") setLog((l) => [...l.slice(-20), e.message]);
      if (e.type === "step") {
        setActions((a) => ({
          ...a,
          [e.stepId]: { stepId: e.stepId, status: e.status, resultText: e.result ?? null, error: e.error ?? null, inverseAction: null },
        }));
      }
      if (e.type === "status" || e.type === "done") {
        setRun((r) => (r ? { ...r, status: e.status } : r));
        onChanged(runId, e.status, FINISHED.includes(e.status));
      }
      if (e.type === "plan" || e.type === "question" || e.type === "done") void load();
    });
  }, [runId, load, onChanged]);

  const plan = run?.plan ?? null;
  const groups = useMemo(() => {
    const m = new Map<string, ValidatedStep[]>();
    for (const s of plan?.steps ?? []) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    return [...m.entries()];
  }, [plan]);

  if (!run) return <div className="mt-6 text-sm text-muted">{error ?? "Loading run…"}</div>;

  const needsConfirm = Boolean(plan?.requiresConfirmation && plan.steps.some((s) => s.destructive && selected.has(s.id)));
  const canRun = run.status === "awaiting_approval" && selected.size > 0 && (!needsConfirm || confirmText === plan?.confirmationPhrase);
  const anyUndoable = Object.values(actions).some((a) => a.status === "succeeded");

  async function act(path: string, body: unknown = {}, openResult = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ runId?: string }>(`/runs/${runId}/${path}`, { body });
      if (openResult && res.runId) onOpenRun(res.runId, path === "undo" ? `Undo: ${run!.prompt}` : run!.prompt);
      else await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(step: ValidatedStep, on: boolean) {
    const next = new Set(selected);
    if (on) {
      next.add(step.id);
      step.dependsOn.forEach((d) => next.add(d));
    } else {
      next.delete(step.id);
      // Untick anything that depends on this step.
      for (const s of plan!.steps) if (s.dependsOn.includes(step.id)) next.delete(s.id);
    }
    setSelected(next);
  }

  const editable = run.status === "awaiting_approval";

  return (
    <div className="mt-6 grid gap-4">
      <div className="card p-4">
        <div className="text-xs uppercase tracking-wide text-muted">{run.kind === "undo" ? "Undo" : run.kind === "fix" ? "Fix" : "You asked"}</div>
        <p className="mt-1 whitespace-pre-wrap text-sm">{run.prompt}</p>
      </div>

      {run.status === "planning" && (
        <div className="card p-4 text-sm text-muted">
          <span className="animate-pulse">Whispcord is planning…</span>
          {log.length > 0 && <ul className="mt-2 text-xs">{log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        </div>
      )}

      {run.status === "needs_input" && run.pendingQuestion && (
        <div className="card p-4">
          <p className="text-sm">{run.pendingQuestion.question}</p>
          <div className="mt-3 flex gap-2">
            <input className="input" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer"
              onKeyDown={(e) => { if (e.key === "Enter" && answer.trim()) void act("answer", { answer }).then(() => setAnswer("")); }} />
            <button className="btn-primary" disabled={busy || !answer.trim()} onClick={() => act("answer", { answer }).then(() => setAnswer(""))}>Reply</button>
          </div>
        </div>
      )}

      {plan && (
        <div className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">Plan</h3>
              <p className="mt-1 text-sm text-muted">{plan.summary}</p>
            </div>
            <span className="text-xs text-muted">{plan.steps.length} steps</span>
          </div>

          <div className="mt-4 grid gap-4">
            {groups.map(([group, steps]) => (
              <div key={group}>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">{GROUP_ICONS[group] ?? "•"} {group}</div>
                <ul className="mt-1 grid gap-1">
                  {steps.map((s) => (
                    <StepRow key={s.id} step={s} action={actions[s.id]} checked={selected.has(s.id)} editable={editable} onToggle={(on) => toggle(s, on)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {plan.warnings.length > 0 && (
            <ul className="mt-4 grid gap-1 text-xs text-warn">{plan.warnings.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
          )}

          {editable && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              {needsConfirm && (
                <input className="input max-w-56 border-danger/50" placeholder={`Type ${plan.confirmationPhrase} to allow deletions`}
                  value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              )}
              <button className="btn-ghost" disabled={busy} onClick={() => act("cancel")}>Cancel</button>
              <button className={needsConfirm ? "btn-danger" : "btn-primary"} disabled={busy || !canRun}
                onClick={() => act("approve", { stepIds: [...selected], confirmation: confirmText || undefined })}>
                Run {selected.size} step{selected.size === 1 ? "" : "s"}
              </button>
            </div>
          )}
        </div>
      )}

      {run.status === "running" && <p className="text-sm text-muted animate-pulse">Running…</p>}

      {run.status === "failed" && (
        <div className="card border-danger/40 p-4">
          <p className="whitespace-pre-wrap text-sm text-danger">{run.error ?? "The run failed."}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {run.approvedStepIds && <button className="btn-ghost" disabled={busy} onClick={() => act("retry")}>Retry failed step</button>}
            {run.kind !== "undo" && <button className="btn-ghost" disabled={busy} onClick={() => act("fix", {}, true)}>Ask Whispcord to fix</button>}
            {run.kind !== "undo" && anyUndoable && <button className="btn-ghost" disabled={busy} onClick={() => act("undo", {}, true)}>Undo what ran</button>}
          </div>
        </div>
      )}

      {run.status === "done" && (
        <div className="card flex flex-wrap items-center gap-3 border-ok/40 p-4 text-sm">
          <span className="flex-1 text-ok">{run.kind === "undo" ? "Undone." : "Done. Your server has been updated."}</span>
          {run.kind !== "undo" && anyUndoable && <button className="btn-ghost" disabled={busy} onClick={() => act("undo", {}, true)}>Undo</button>}
        </div>
      )}

      {run.status === "undone" && <p className="text-sm text-muted">This run was undone.</p>}
      {run.status === "cancelled" && <p className="text-sm text-muted">Cancelled. Nothing was changed.</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function StepRow({ step, action, checked, editable, onToggle }: {
  step: ValidatedStep; action?: ActionDto; checked: boolean; editable: boolean; onToggle: (on: boolean) => void;
}) {
  const statusIcon: Record<string, string> = { running: "⏳", succeeded: "✅", failed: "❌", skipped: "⏭", pending: "·" };
  const args = Object.entries(step.args).map(([k, v]) => `${k}: ${v}`).join(", ");
  return (
    <li className={`rounded-lg px-2 py-1.5 ${step.destructive ? "bg-danger/10" : ""}`}>
      <label className="flex items-start gap-2 text-sm">
        {editable ? (
          <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        ) : (
          <span className="w-4 text-center">{action ? statusIcon[action.status] : "·"}</span>
        )}
        <span className="min-w-0 flex-1">
          <span className={step.destructive ? "font-medium text-danger" : "font-medium"}>{step.tool.replaceAll("_", " ")}</span>
          <span className="ml-2 break-all text-xs text-muted">{args}</span>
          {step.reason && <span className="block text-xs text-muted">{step.reason}</span>}
          {step.destructive && <span className="block text-xs text-danger">Deletes data. This can’t be undone.</span>}
          {action?.error && <span className="block whitespace-pre-wrap text-xs text-danger">{action.error}</span>}
        </span>
      </label>
    </li>
  );
}
