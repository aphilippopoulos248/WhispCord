"use client";

import { USER_TOGGLEABLE_TIERS, type GuildSnapshot, type Tier } from "@whispcord/shared";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RunThread } from "./RunThread";
import { ServerIcon } from "./ServerIcon";
import { StatusDot, StatusPill } from "./StatusPill";

export interface ServerInfo {
  id: string;
  guild_id: string;
  name: string;
  icon: string | null;
  status: string;
  bot_role_ok: boolean;
  enabled_tiers: Tier[];
}

export interface RunSummary {
  id: string;
  kind: string;
  prompt: string;
  status: string;
  created_at: string;
  parent_run_id: string | null;
}

const CHIPS = [
  "Set up a gaming community with general, clips and LFG channels and a voice lounge",
  "Add a staff-only area that only Moderators can see",
  "Create roles for Valorant, Minecraft and Fortnite players with matching colours",
];

type Tab = "workspace" | "history" | "settings";

export function Workspace(props: {
  server: ServerInfo;
  servers: ServerInfo[];
  isOwner: boolean;
  initialRuns: RunSummary[];
  justConnected: boolean;
}) {
  const { server } = props;
  const [tab, setTab] = useState<Tab>("workspace");
  const [prompt, setPrompt] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(
    props.initialRuns.find((r) => ["planning", "needs_input", "awaiting_approval", "running"].includes(r.status))?.id ?? null,
  );
  const [runs, setRuns] = useState(props.initialRuns);
  const [snapshot, setSnapshot] = useState<GuildSnapshot | null>(null);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [botRoleOk, setBotRoleOk] = useState(server.bot_role_ok);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshMirror = useCallback(async () => {
    try {
      setSnapshot(await api<GuildSnapshot>(`/servers/${server.guild_id}/snapshot`));
      setMirrorError(null);
    } catch (e) {
      setMirrorError((e as Error).message);
    }
  }, [server.guild_id]);

  const checkBot = useCallback(async () => {
    try {
      const res = await api<{ botRoleOk: boolean }>(`/servers/${server.guild_id}/bot-status`);
      setBotRoleOk(res.botRoleOk);
    } catch {
      /* shown via mirror error */
    }
  }, [server.guild_id]);

  useEffect(() => {
    void refreshMirror();
    void checkBot();
  }, [refreshMirror, checkBot]);

  async function startRun(text: string) {
    setError(null);
    setBusy(true);
    try {
      const { runId } = await api<{ runId: string }>(`/servers/${server.guild_id}/runs`, { body: { prompt: text } });
      setRuns((r) => [{ id: runId, kind: "prompt", prompt: text, status: "planning", created_at: new Date().toISOString(), parent_run_id: null }, ...r]);
      setActiveRunId(runId);
      setPrompt("");
      setTab("workspace");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onRunChanged = useCallback((id: string, status: string, finished: boolean) => {
    setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));
    if (finished) void refreshMirror();
  }, [refreshMirror]);

  const openRun = (id: string, prompt?: string) => {
    setRuns((rs) => (rs.some((r) => r.id === id) ? rs : [{ id, kind: "prompt", prompt: prompt ?? "", status: "planning", created_at: new Date().toISOString(), parent_run_id: null }, ...rs]));
    setActiveRunId(id);
    setTab("workspace");
  };

  return (
    <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
      {/* Sidebar */}
      <aside className="hidden w-56 shrink-0 md:block">
        <div className="text-xs font-medium uppercase tracking-wide text-muted">Servers</div>
        <ul className="mt-2 grid gap-1">
          {props.servers.map((s) => (
            <li key={s.id}>
              <Link
                href={`/servers/${s.guild_id}`}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-panel-2 ${s.id === server.id ? "bg-panel-2" : ""}`}
              >
                <StatusDot status={s.status} roleOk={s.bot_role_ok} />
                <span className="truncate">{s.name}</span>
              </Link>
            </li>
          ))}
        </ul>
        <Link href="/servers" className="mt-3 block px-2 text-sm text-accent">+ Connect a server</Link>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <ServerIcon name={server.name} icon={server.icon} />
          <h1 className="text-xl font-semibold">{server.name}</h1>
          <StatusPill status={server.status} roleOk={botRoleOk} />
          <nav className="ml-auto flex gap-1 rounded-lg border border-line p-1 text-sm">
            {(["workspace", "history", "settings"] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 capitalize ${tab === t ? "bg-panel-2" : "text-muted"}`}>
                {t}
              </button>
            ))}
          </nav>
        </div>

        {props.justConnected && (
          <div className="card mt-4 border-ok/40 p-4 text-sm">Whispcord is connected. Try a prompt below.</div>
        )}
        {!botRoleOk && server.status === "connected" && (
          <div className="card mt-4 flex flex-wrap items-center gap-3 border-warn/40 p-4 text-sm">
            <span className="flex-1">
              Drag the <strong>Whispcord</strong> role near the top of your role list (Server Settings → Roles) so it can manage your other roles.
            </span>
            <button className="btn-ghost" onClick={checkBot}>Check again</button>
          </div>
        )}

        {tab === "workspace" && (
          <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className="min-w-0">
              <div className="card p-4">
                <textarea
                  className="input min-h-24 resize-y"
                  placeholder="Describe what you want, e.g. “Create a Gaming category with general, clips and LFG text channels and a Squad voice channel.”"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) void startRun(prompt);
                  }}
                  maxLength={4000}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {CHIPS.map((c) => (
                    <button key={c} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-text" onClick={() => setPrompt(c)}>
                      {c.length > 48 ? c.slice(0, 46) + "…" : c}
                    </button>
                  ))}
                  <button className="btn-primary ml-auto" disabled={busy || !prompt.trim() || server.status !== "connected"} onClick={() => startRun(prompt)}>
                    {busy ? "Starting…" : "Plan it"}
                  </button>
                </div>
                {error && <p className="mt-3 text-sm text-danger">{error}</p>}
              </div>

              {activeRunId ? (
                <RunThread key={activeRunId} runId={activeRunId} onChanged={onRunChanged} onOpenRun={openRun} />
              ) : (
                <p className="mt-6 text-sm text-muted">Your plan will appear here. Nothing changes on your server until you click Run.</p>
              )}
            </div>

            <ServerMirror snapshot={snapshot} error={mirrorError} onRefresh={refreshMirror} />
          </div>
        )}

        {tab === "history" && (
          <div className="card mt-6 divide-y divide-line">
            {runs.length === 0 && <p className="p-4 text-sm text-muted">No runs yet.</p>}
            {runs.map((r) => (
              <button key={r.id} className="flex w-full items-center gap-3 p-3 text-left hover:bg-panel-2" onClick={() => openRun(r.id)}>
                <span className="w-36 shrink-0 text-xs text-muted">{new Date(r.created_at).toLocaleString()}</span>
                <span className="flex-1 truncate text-sm">{r.prompt}</span>
                <span className="text-xs text-muted">{r.status.replace("_", " ")}</span>
              </button>
            ))}
          </div>
        )}

        {tab === "settings" && <Settings server={server} isOwner={props.isOwner} />}
      </div>
    </div>
  );
}

function ServerMirror({ snapshot, error, onRefresh }: { snapshot: GuildSnapshot | null; error: string | null; onRefresh: () => void }) {
  return (
    <aside className="card h-fit p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Server structure</h2>
        <button className="text-xs text-muted hover:text-text" onClick={onRefresh}>Refresh</button>
      </div>
      {error && <p className="mt-3 text-danger">{error}</p>}
      {!snapshot && !error && <p className="mt-3 text-muted">Loading…</p>}
      {snapshot && <MirrorBody s={snapshot} />}
    </aside>
  );
}

function MirrorBody({ s }: { s: GuildSnapshot }) {
  const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  const cats = s.channels.filter((c) => c.type === "CATEGORY").sort(byPos);
  const loose = s.channels.filter((c) => c.type !== "CATEGORY" && !c.parentId).sort(byPos);
  const icon = (type: string) => (type === "VOICE" || type === "STAGE" ? "🔊" : type === "FORUM" ? "💬" : "#");
  return (
    <div className="mt-3 grid gap-3">
      <ul className="grid gap-0.5">
        {loose.map((c) => (
          <li key={c.id} className="text-muted"><span className="mr-1">{icon(c.type)}</span>{c.name}</li>
        ))}
        {cats.map((cat) => (
          <li key={cat.id} className="mt-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">📁 {cat.name}</div>
            <ul className="mt-1 grid gap-0.5 pl-2">
              {s.channels.filter((c) => c.parentId === cat.id).sort(byPos).map((c) => (
                <li key={c.id} className="text-muted"><span className="mr-1">{icon(c.type)}</span>{c.name}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Roles</div>
        <ul className="mt-1 grid gap-0.5">
          {[...s.roles].filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position).map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "#8b93a7" }} />
              <span className={r.position >= s.botHighestRolePosition ? "text-muted" : ""}>{r.name}</span>
              {r.managed && <span className="text-xs text-muted">bot</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const TIER_LABELS: Record<string, [string, string]> = {
  build: ["Build", "Create and edit channels, categories, roles, permissions, webhooks, events, invites and emojis."],
  destructive: ["Deletions", "Allow plans that delete things. Each one still needs you to type DELETE."],
  moderate: ["Moderation", "Assign roles, nicknames, timeouts, kicks and bans. Requires the Builder + Moderation bot permissions."],
  messaging: ["Messaging", "Send, edit and react to messages in channels."],
};

function Settings({ server, isOwner }: { server: ServerInfo; isOwner: boolean }) {
  const [tiers, setTiers] = useState<Tier[]>(server.enabled_tiers);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  async function save(next: Tier[]) {
    setTiers(next);
    setSaved(null);
    setError(null);
    try {
      const res = await api<{ enabledTiers: Tier[]; needsPermissionUpgrade?: boolean }>(`/servers/${server.guild_id}/settings`, {
        method: "PATCH",
        body: { enabledTiers: next.filter((t) => t !== "read") },
      });
      setTiers(res.enabledTiers);
      setNeedsUpgrade(Boolean(res.needsPermissionUpgrade));
      setSaved("Saved");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function upgradePermissions() {
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>(`/servers/${server.guild_id}/permissions-upgrade`, { body: {} });
      window.location.href = authorizeUrl;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect this server from Whispcord? The bot stays in the server until you kick it.")) return;
    try {
      await api(`/servers/${server.guild_id}/disconnect`, { method: "POST", body: {} });
      window.location.href = "/servers";
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mt-6 grid max-w-2xl gap-6">
      <section className="card p-4">
        <h2 className="font-medium">What Whispcord may do here</h2>
        {!isOwner && <p className="mt-1 text-sm text-muted">Only the person who connected this server can change these.</p>}
        <div className="mt-4 grid gap-3">
          {USER_TOGGLEABLE_TIERS.map((t) => (
            <label key={t} className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={tiers.includes(t)}
                disabled={!isOwner}
                onChange={(e) => save(e.target.checked ? [...tiers, t] : tiers.filter((x) => x !== t))}
              />
              <span>
                <span className="font-medium">{TIER_LABELS[t]?.[0] ?? t}</span>
                <span className="block text-muted">{TIER_LABELS[t]?.[1]}</span>
              </span>
            </label>
          ))}
        </div>
        {needsUpgrade && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-warn/40 p-3 text-sm">
            <span className="flex-1">Moderation needs extra bot permissions (kick, ban, timeout, nicknames). Discord will ask you to approve them.</span>
            <button className="btn-primary" onClick={upgradePermissions}>Grant moderation permissions</button>
          </div>
        )}
        <p className="mt-4 text-xs text-muted">Direct messages and user lookups are never available through Whispcord.</p>
        {saved && <p className="mt-2 text-sm text-ok">{saved}</p>}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </section>
      <section className="card p-4">
        <h2 className="font-medium">Disconnect</h2>
        <p className="mt-1 text-sm text-muted">Stops Whispcord from acting on this server. To remove the bot entirely, kick it in Discord.</p>
        <button className="btn-danger mt-3" onClick={disconnect}>Disconnect server</button>
      </section>
    </div>
  );
}
