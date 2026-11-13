"use client";

import type { LiveFlag, LiveWatch } from "@whispcord/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, subscribeWatch } from "@/lib/api";

export interface WatchFeed {
  watches: LiveWatch[];
  flags: LiveFlag[];
  paused: string | null;
  loaded: boolean;
  error: string | null;
  notice: string | null;
  /** Flags that arrived since the page loaded (highlighted in the log). */
  fresh: Set<string>;
  /** The most recent flag to arrive live, for the pop-up. */
  latest: LiveFlag | null;
  stop: (watchId: string) => Promise<void>;
  dismiss: (flagId: string) => Promise<void>;
  reload: () => Promise<void>;
}

/** Loads a server's watches and flags, then keeps them live over SSE. */
export function useWatchFeed(guildId: string): WatchFeed {
  const [watches, setWatches] = useState<LiveWatch[]>([]);
  const [flags, setFlags] = useState<LiveFlag[]>([]);
  const [paused, setPaused] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [latest, setLatest] = useState<LiveFlag | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ watches: LiveWatch[]; flags: LiveFlag[]; paused: string | null }>(`/servers/${guildId}/watch`);
      setWatches(res.watches);
      setFlags(res.flags);
      setPaused(res.paused);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [guildId]);

  useEffect(() => {
    void reload();
    return subscribeWatch(guildId, (e) => {
      if (e.type === "flag") {
        setFlags((fs) => (fs.some((f) => f.id === e.flag.id) ? fs : [e.flag, ...fs].slice(0, 200)));
        setFresh((s) => new Set(s).add(e.flag.id));
        setLatest(e.flag);
      } else if (e.type === "flag_updated") {
        setFlags((fs) => fs.map((f) => (f.id === e.flag.id ? e.flag : f)));
      } else if (e.type === "watches") {
        setWatches(e.watches);
      } else if (e.type === "notice") {
        setNotice(e.message);
      }
    });
  }, [guildId, reload]);

  const stop = async (watchId: string) => {
    await api(`/servers/${guildId}/watches/${watchId}/stop`, { body: {} });
    await reload();
  };
  const dismiss = async (flagId: string) => {
    const { flag } = await api<{ flag: LiveFlag }>(`/servers/${guildId}/flags/${flagId}/dismiss`, { body: {} });
    setFlags((fs) => fs.map((f) => (f.id === flag.id ? flag : f)));
  };

  return { watches, flags, paused, loaded, error, notice, fresh, latest, stop, dismiss, reload };
}

const SEVERITY: Record<LiveFlag["severity"], { cls: string; label: string }> = {
  high: { cls: "bg-danger/15 text-danger", label: "HIGH" },
  medium: { cls: "bg-warn/15 text-warn", label: "MEDIUM" },
  low: { cls: "bg-panel-2 text-muted", label: "LOW" },
};

function ago(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function WatchPanel({ feed, enabled, connected, channelName, onPlan, onSetUp }: {
  feed: WatchFeed;
  /** Live watch switched on in Settings. */
  enabled: boolean;
  connected: boolean;
  channelName: (id: string) => string | null;
  /** Starts a normal plan (that the owner approves) from a prompt. */
  onPlan: (prompt: string) => void;
  /** Puts a starter prompt in the command input. */
  onSetUp: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const active = feed.watches.filter((w) => w.status === "active");
  const listening = enabled && connected && active.length > 0 && !feed.paused;

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const status = !enabled
    ? { led: "led-off", tone: "text-danger", text: "SWITCHED OFF" }
    : feed.paused
      ? { led: "led-warn", tone: "text-warn", text: "PAUSED" }
      : listening
        ? { led: "led-ok", tone: "text-ok", text: "LISTENING" }
        : { led: "", tone: "text-muted", text: "NO WATCHES" };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* Flag log */}
      <section className="well min-w-0 overflow-hidden" aria-labelledby="flag-log-title">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-[#2b313d] px-4 py-2.5">
          <h2 id="flag-log-title" className="label-caps">Flag log</h2>
          <span className="flex items-center gap-2 font-mono text-[10.5px] font-bold tracking-[0.12em]">
            <span className={`led ${status.led} ${listening ? "animate-pulse" : ""}`} aria-hidden />
            <span className={status.tone}>{status.text}</span>
          </span>
        </div>

        {!enabled && (
          <p className="strip strip-danger m-3">
            Live watch is switched off for this server. Turn on the WATCH switch in Settings to let watches run.
          </p>
        )}
        {enabled && feed.paused && <p className="strip strip-warn m-3 text-warn">{feed.paused}</p>}
        {feed.notice && <p className="strip strip-warn m-3 text-warn">{feed.notice}</p>}
        {(feed.error || error) && <p className="m-3 text-sm text-danger">{error ?? feed.error}</p>}

        {feed.loaded && feed.flags.length === 0 && (
          <p className="px-4 py-10 text-center font-mono text-xs tracking-[0.14em] text-dim">
            {active.length ? "LISTENING. NOTHING FLAGGED YET." : "NO FLAGS. START A WATCH TO CATCH NEW MESSAGES AS THEY’RE POSTED."}
          </p>
        )}

        <ul aria-live="polite">
          {feed.flags.map((f) => {
            const sev = SEVERITY[f.severity];
            const open = f.action === "none";
            return (
              <li
                key={f.id}
                className={`grid gap-1.5 border-b border-[#191d24] px-4 py-3 last:border-b-0 ${feed.fresh.has(f.id) ? "flag-fresh" : ""} ${open ? "" : "opacity-70"}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] ${sev.cls}`}>{sev.label}</span>
                  <span className="font-mono text-muted">#{f.channelName || channelName(f.channelId) || f.channelId}</span>
                  <span className="font-medium">{f.authorName}</span>
                  <span className="font-mono text-[11px] text-dim">{ago(f.flaggedAt)}</span>
                  {f.action === "auto_deleted" && <span className="rounded border border-danger/50 px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] text-danger">AUTO-DELETED</span>}
                  {f.action === "auto_delete_failed" && <span className="rounded border border-warn/50 px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] text-warn">NOT DELETED</span>}
                  {f.action === "dismissed" && <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] text-muted">DISMISSED</span>}
                  <a href={f.jumpUrl} target="_blank" rel="noreferrer" className="ml-auto font-mono text-[11px] text-accent-hi">Open in Discord ↗</a>
                </div>
                <p className="text-[13px] text-muted">{f.reason}</p>
                {f.actionError && <p className="text-xs text-warn">{f.actionError}</p>}
                {shown.has(f.id) && <blockquote className="whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-[13px]">{f.excerpt}</blockquote>}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="text-xs text-muted underline"
                    onClick={() => setShown((s) => { const n = new Set(s); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n; })}
                  >
                    {shown.has(f.id) ? "Hide message" : "Show message"}
                  </button>
                  {open && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      <button className="btn-ghost px-2.5 py-1.5 text-[10px]" disabled={busy !== null} onClick={() => run(f.id, () => feed.dismiss(f.id))}>
                        Dismiss
                      </button>
                      <button
                        className="btn px-2.5 py-1.5 text-[10px]"
                        onClick={() => onPlan(`Time out the member with ID ${f.authorId} for 1 hour because of a flagged message (message ${f.messageId} in channel ${f.channelId}).`)}
                      >
                        Plan timeout
                      </button>
                      <button
                        className="btn-danger px-2.5 py-1.5 text-[10px]"
                        onClick={() => onPlan(`Delete the flagged message ${f.messageId} in channel ${f.channelId}.`)}
                      >
                        Plan delete
                      </button>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Running watches */}
      <aside className="grid gap-3" aria-labelledby="watches-title">
        <div className="rounded-[14px] border border-[#333949] bg-gradient-to-b from-[#1c2029] to-[#14171d] p-4">
          <div className="flex items-baseline justify-between">
            <h2 id="watches-title" className="label-caps">Watches</h2>
            <span className="label-caps">{active.length} running</span>
          </div>
          <ul className="mt-3 grid gap-2.5">
            {active.map((w) => (
              <li key={w.id} className="well grid gap-2 p-3">
                <p className="font-mono text-[12.5px] text-phosphor">› {w.criteria}</p>
                <p className="text-xs text-muted">
                  {w.channelIds.length ? w.channelIds.map((id) => `#${channelName(id) ?? id}`).join(", ") : "Every text channel"} · started {ago(w.createdAt)}
                </p>
                <div className="flex items-center gap-2">
                  {w.autoDelete
                    ? <span className="rounded border border-danger/50 px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] text-danger">AUTO-DELETE HIGH</span>
                    : <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] text-muted">FLAG ONLY</span>}
                  <button className="btn-ghost ml-auto px-2.5 py-1.5 text-[10px]" disabled={busy !== null} onClick={() => run(w.id, () => feed.stop(w.id))}>
                    {busy === w.id ? "Stopping…" : "Stop"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {active.length === 0 && (
            <div className="mt-3 grid gap-2.5">
              <p className="text-[13px] text-muted">
                Ask for one in plain English, like “Catch any hurtful messages and flag them”. You approve it like any other plan.
              </p>
              <button className="btn-primary" disabled={!enabled || !connected} onClick={onSetUp}>Set up a watch</button>
            </div>
          )}
        </div>
        <p className="px-1 text-[12px] leading-relaxed text-muted">
          New messages in watched channels, including attached images, are sent to Anthropic (Claude) to check them. Images aren’t stored. Flags, with a short text excerpt, are kept for 30 days.
          Auto-delete only removes high-severity matches and needs Deletions switched on.
        </p>
      </aside>
    </div>
  );
}

/** Pop-up shown when a flag arrives while you're on another tab. */
export function FlagToast({ flag, onView, onClose }: { flag: LiveFlag | null; onView: () => void; onClose: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!flag) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(onClose, 8000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [flag, onClose]);
  if (!flag) return null;
  const sev = SEVERITY[flag.severity];
  return (
    <div
      role="status"
      className="toast-in fixed bottom-[max(16px,env(safe-area-inset-bottom))] right-[max(16px,env(safe-area-inset-right))] z-50 grid w-[min(360px,calc(100vw-32px))] gap-2 rounded-xl border border-danger/50 bg-[#181c24] p-3.5 shadow-[0_20px_50px_rgb(0_0_0/0.5)]"
    >
      <div className="flex items-center gap-2">
        <span className="led led-danger" aria-hidden />
        <span className="label-caps text-danger">New flag</span>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] ${sev.cls}`}>{sev.label}</span>
        <button className="ml-auto text-muted hover:text-text" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <p className="text-[13px]"><span className="font-mono text-muted">#{flag.channelName}</span> · <span className="font-medium">{flag.authorName}</span></p>
      <p className="text-[12.5px] text-muted">{flag.reason}</p>
      <button className="btn-primary justify-self-start px-3 py-1.5 text-[10px]" onClick={onView}>View in Watch</button>
    </div>
  );
}
