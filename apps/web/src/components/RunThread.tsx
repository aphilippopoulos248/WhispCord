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

  if (!run) return <div className="px-1 font-mono text-xs text-muted">{error ?? "Loading run…"}</div>;

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
      // Switch off anything that depends on this step.
      for (const s of plan!.steps) if (s.dependsOn.includes(step.id)) next.delete(s.id);
    }
    setSelected(next);
  }

  const editable = run.status === "awaiting_approval";
  const armed = needsConfirm && confirmText === plan?.confirmationPhrase;

  return (
    <div className="grid gap-3">
      <div className="card grid gap-1 p-3.5">
        <div className="label-caps text-[10px]">{run.kind === "undo" ? "Undo" : run.kind === "fix" ? "Fix" : "You asked"}</div>
        <p className="whitespace-pre-wrap text-sm">{run.prompt}</p>
      </div>

      {run.status === "planning" && (
        <div className="well grid gap-1 p-3.5">
          <span className="label-caps text-[#4f8a70]">Planning</span>
          <ul className="grid gap-0.5 font-mono text-xs text-phosphor">
            {log.map((l, i) => <li key={i}>› {l}</li>)}
            <li><span className="blink-cursor" aria-hidden /><span className="sr-only">Whispcord is planning…</span></li>
          </ul>
        </div>
      )}

      {run.status === "needs_input" && run.pendingQuestion && (
        <div className="card grid gap-3 border-warn/40 p-3.5">
          <div className="flex items-start gap-2.5">
            <span className="led led-busy mt-1.5" aria-hidden />
            <p className="text-sm">{run.pendingQuestion.question}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" aria-label="Your answer"
              onKeyDown={(e) => { if (e.key === "Enter" && answer.trim()) void act("answer", { answer }).then(() => setAnswer("")); }} />
            <button className="btn-primary" disabled={busy || !answer.trim()} onClick={() => act("answer", { answer }).then(() => setAnswer(""))}>Reply</button>
          </div>
        </div>
      )}

      {plan && (
        <div className="card grid gap-3.5 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[17px] font-semibold">Plan</h3>
              <p className="mt-0.5 text-[13px] text-muted">{plan.summary}</p>
            </div>
            <span className="whitespace-nowrap font-mono text-[11px] text-muted">{plan.steps.length} steps</span>
          </div>

          {groups.map(([group, steps]) => (
            <div key={group} className="grid gap-1.5">
              <div className="label-caps">{group}</div>
              <ul className="grid gap-1.5">
                {steps.map((s) => (
                  <StepRow key={s.id} step={s} action={actions[s.id]} checked={selected.has(s.id)} editable={editable} onToggle={(on) => toggle(s, on)} />
                ))}
              </ul>
            </div>
          ))}

          {plan.warnings.length > 0 && (
            <ul className="grid gap-1 text-[12.5px] text-warn">{plan.warnings.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
          )}

          {editable && (
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              {needsConfirm ? (
                <label className="grid min-w-[200px] flex-1 gap-1">
                  <span className="label-caps text-danger">Type {plan.confirmationPhrase} to arm deletions</span>
                  <input
                    className="input max-w-64 border-danger/50 font-mono tracking-[0.14em] text-danger focus:border-danger"
                    placeholder={plan.confirmationPhrase ?? undefined}
                    autoComplete="off"
                    spellCheck={false}
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                  />
                </label>
              ) : (
                <span className="min-w-[200px] flex-1 text-[13px] text-muted">Switch off any step you don’t want, then press RUN.</span>
              )}
              <button className="btn-ghost" disabled={busy} onClick={() => act("cancel")}>Cancel</button>
              <div className={`run-wrap ${armed ? "is-open" : ""}`}>
                {needsConfirm && <span className="run-cover" aria-hidden>TYPE {plan.confirmationPhrase}</span>}
                <button
                  className={`run-key ${needsConfirm ? "is-danger" : ""}`}
                  disabled={busy || !canRun}
                  onClick={() => act("approve", { stepIds: [...selected], confirmation: confirmText || undefined })}
                >
                  RUN {selected.size}
                  <span className="sr-only"> step{selected.size === 1 ? "" : "s"}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {run.status === "running" && (
        <p className="flex items-center gap-2 px-1 font-mono text-xs text-warn"><span className="led led-busy" aria-hidden />Running…</p>
      )}

      {run.status === "failed" && (
        <div className="strip strip-danger items-start">
          <span className="led led-danger mt-1" aria-hidden />
          <div className="grid min-w-[200px] flex-1 gap-3">
            <p className="whitespace-pre-wrap text-danger">{run.error ?? "The run failed."}</p>
            <div className="flex flex-wrap gap-2">
              {run.approvedStepIds && <button className="btn" disabled={busy} onClick={() => act("retry")}>Retry failed step</button>}
              {run.kind !== "undo" && <button className="btn" disabled={busy} onClick={() => act("fix", {}, true)}>Ask Whispcord to fix</button>}
              {run.kind !== "undo" && anyUndoable && <button className="btn" disabled={busy} onClick={() => act("undo", {}, true)}>Undo what ran</button>}
            </div>
          </div>
        </div>
      )}

      {run.messageSearch && run.messageSearch.searches.length > 0 && <MessageFindings search={run.messageSearch} />}

      {run.report && (
        <div className="card grid gap-1 p-3.5 text-sm">
          <div className="label-caps text-[10px]">Whispcord</div>
          <p className="whitespace-pre-wrap">{run.report}</p>
          <p className="font-mono text-[11px] text-muted">Nothing on your server was changed.</p>
        </div>
      )}

      {run.status === "done" && !run.report && (
        <div className="strip strip-ok">
          <span className="led led-ok" aria-hidden />
          <p className="flex-1">{run.kind === "undo" ? "Undone." : "Done. Your server has been updated."}</p>
          {run.kind !== "undo" && anyUndoable && <button className="btn" disabled={busy} onClick={() => act("undo", {}, true)}>Undo</button>}
        </div>
      )}

      {run.status === "undone" && <p className="px-1 text-sm text-muted">This run was undone.</p>}
      {run.status === "cancelled" && <p className="px-1 text-sm text-muted">Cancelled. Nothing was changed.</p>}
      {error && <p className="px-1 text-sm text-danger">{error}</p>}
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
    <div className="card grid gap-3 p-3.5 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[17px] font-semibold">Messages found</h3>
        <span className="font-mono text-[11px] text-muted">
          {search.findings.length} match{search.findings.length === 1 ? "" : "es"} · {scanned} message{scanned === 1 ? "" : "s"} checked
        </span>
      </div>

      {hidden && (
        <p className="strip strip-warn text-warn">
          Discord hid the message text, so nothing could be checked. Turn on <strong>Message Content Intent</strong> (Developer
          Portal → Bot) and set <code>WHISPCORD_MESSAGE_CONTENT=true</code> for the Discord server process, then restart it.
        </p>
      )}
      {(incomplete > 0 || truncated || skipped.length > 0) && (
        <ul className="grid gap-1 text-xs text-muted">
          {incomplete > 0 && <li>⚠ {incomplete} batch(es) of messages couldn’t be checked.</li>}
          {truncated && <li>⚠ The search hit its message limit; older messages weren’t checked.</li>}
          {skipped.map((c) => <li key={c.id}>Skipped #{c.name ?? c.id}: {c.reason}</li>)}
        </ul>
      )}

      {search.findings.length > 0 && (
        <ul className="divide-y divide-line">
          {search.findings.map((f) => (
            <li key={f.messageId} className="grid gap-1 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase ${SEVERITY_STYLE[f.severity]}`}>{f.severity}</span>
                <span className="font-mono text-muted">#{f.channelName}</span>
                <span className="font-medium">{f.authorName}</span>
                <span className="font-mono text-[11px] text-dim">{new Date(f.createdAt).toLocaleString()}</span>
                <a href={f.jumpUrl} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-accent-hi">Open in Discord ↗</a>
              </div>
              <p className="text-muted">{f.reason}</p>
              {shown.has(f.messageId) ? (
                <blockquote className="whitespace-pre-wrap break-words border-l-2 border-line pl-3">{f.excerpt}</blockquote>
              ) : null}
              <button className="justify-self-start text-xs text-muted underline" onClick={() => toggle(f.messageId)}>
                {shown.has(f.messageId) ? "Hide message" : "Show message"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTION_LIGHT: Record<ActionStatus, string> = {
  pending: "",
  running: "led-busy",
  succeeded: "led-ok",
  failed: "led-danger",
  skipped: "",
};

function StepRow({ step, action, checked, editable, onToggle }: {
  step: ValidatedStep; action?: ActionDto; checked: boolean; editable: boolean; onToggle: (on: boolean) => void;
}) {
  const args = Object.entries(step.args).map(([k, v]) => `${k}: ${v}`).join(", ");
  const title = step.tool.replaceAll("_", " ");
  // While choosing, the light previews the switch. After approval it shows the step's progress.
  const light = editable ? (checked ? (step.destructive ? "led-danger" : "led-ok") : "") : action ? ACTION_LIGHT[action.status] : "";
  const included = editable ? checked : action ? action.status !== "skipped" : checked;
  return (
    <li
      className={`grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2.5 rounded-[9px] border px-2.5 py-2 ${
        step.destructive ? "border-danger/50 bg-danger/[0.07]" : "border-[#2d3340] bg-[#1e232c]"
      } ${included ? "" : "opacity-55"}`}
    >
      <button
        role="switch"
        aria-checked={included}
        aria-label={`Include step: ${title}`}
        className={`mini-switch ${step.destructive ? "is-danger" : ""}`}
        disabled={!editable}
        onClick={() => onToggle(!checked)}
      />
      <span className={`led ${light}`} role="img" aria-label={action ? action.status : included ? "included" : "skipped"} />
      <span className="min-w-0">
        <span className={`font-mono text-[11px] ${step.destructive ? "text-danger" : "text-accent-hi"}`}>{title}</span>
        <span className="ml-2 break-all text-[13px]">{args}</span>
        {step.reason && <span className="block text-xs text-muted">{step.reason}</span>}
        {step.destructive && <span className="block text-xs text-danger">Deletes data. This can’t be undone.</span>}
        {action?.error && <span className="block whitespace-pre-wrap text-xs text-danger">{action.error}</span>}
      </span>
    </li>
  );
}
