"use client";

import type { ActionStatus, MessageFinding, MessageSearchStats, RunEvent, RunStatus, ValidatedPlan, ValidatedStep } from "@whispcord/shared";
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
  report: string | null;
  messageSearch: {
    findings: MessageFinding[];
    searches: Array<MessageSearchStats & { criteria: string }>;
  } | null;
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
      if (e.type === "plan" || e.type === "question" || e.type === "report" || e.type === "done") void load();
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

      {run.messageSearch && run.messageSearch.searches.length > 0 && <MessageFindings search={run.messageSearch} />}

      {run.report && (
        <div className="card p-4 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted">Whispcord</div>
          <p className="mt-1 whitespace-pre-wrap">{run.report}</p>
          <p className="mt-2 text-xs text-muted">Nothing on your server was changed.</p>
        </div>
      )}

      {run.status === "done" && !run.report && (
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

const SEVERITY_STYLE: Record<MessageFinding["severity"], string> = {
  high: "bg-danger/15 text-danger",
  medium: "bg-warn/15 text-warn",
  low: "bg-panel-2 text-muted",
};

/** Matches from message search. Message text is hidden until the admin chooses to show it. */
function MessageFindings({ search }: { search: NonNullable<RunDto["messageSearch"]> }) {
  const [shown, setShown] = useState<Set<string>>(new Set());
  const scanned = search.searches.reduce((n, s) => n + s.scanned, 0);
  const hidden = search.searches.some((s) => !s.contentAvailable);
  const incomplete = search.searches.reduce((n, s) => n + s.unclassifiedBatches, 0);
  const truncated = search.searches.some((s) => s.truncated);
  const skipped = search.searches.flatMap((s) => s.skippedChannels);
  const toggle = (id: string) =>
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="card p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">Messages found</h3>
        <span className="text-xs text-muted">
          {search.findings.length} match{search.findings.length === 1 ? "" : "es"} · {scanned} message{scanned === 1 ? "" : "s"} checked
        </span>
      </div>

      {hidden && (
        <p className="mt-3 rounded-lg border border-warn/40 p-3 text-warn">
          Discord hid the message text, so nothing could be checked. Turn on <strong>Message Content Intent</strong> (Developer
          Portal → Bot) and set <code>WHISPCORD_MESSAGE_CONTENT=true</code> for the Discord server process, then restart it.
        </p>
      )}
      {(incomplete > 0 || truncated || skipped.length > 0) && (
        <ul className="mt-3 grid gap-1 text-xs text-muted">
          {incomplete > 0 && <li>⚠ {incomplete} batch(es) of messages couldn’t be checked.</li>}
          {truncated && <li>⚠ The search hit its message limit; older messages weren’t checked.</li>}
          {skipped.map((c) => <li key={c.id}>Skipped #{c.name ?? c.id}: {c.reason}</li>)}
        </ul>
      )}

      {search.findings.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {search.findings.map((f) => (
            <li key={f.messageId} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span>
                <span className="text-muted">#{f.channelName}</span>
                <span className="font-medium">{f.authorName}</span>
                <span className="text-xs text-muted">{new Date(f.createdAt).toLocaleString()}</span>
                <a href={f.jumpUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-accent">Open in Discord ↗</a>
              </div>
              <p className="mt-1 text-muted">{f.reason}</p>
              {shown.has(f.messageId) ? (
                <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-3">{f.excerpt}</blockquote>
              ) : null}
              <button className="mt-1 text-xs text-muted underline" onClick={() => toggle(f.messageId)}>
                {shown.has(f.messageId) ? "Hide message" : "Show message"}
              </button>
            </li>
          ))}
        </ul>
      )}
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
