"use client";

import { USER_TOGGLEABLE_TIERS, type GuildSnapshot, type Tier } from "@whispcord/shared";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { RunThread } from "./RunThread";
import { ServerIcon } from "./ServerIcon";
import { serverState, StatusPill } from "./StatusPill";
import { DECK_TIERS, TierPips } from "./TierPips";
import { FlagToast, WatchPanel, useWatchFeed } from "./WatchPanel";

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

const PRESETS: Array<[label: string, prompt: string]> = [
  ["Gaming setup", "Set up a gaming community with general, clips and LFG channels and a voice lounge"],
  ["Staff area", "Add a staff-only area that only Moderators can see"],
  ["Game roles", "Create roles for Valorant, Minecraft and Fortnite players with matching colours"],
  ["Scan messages", "Find hateful or harassing messages from the last 7 days"],
  ["Live watch", "Catch any hurtful or harassing messages from now on and flag them"],
];
const WATCH_PROMPT = PRESETS[4]![1];

type Tab = "workspace" | "watch" | "history" | "settings";
const TABS: Tab[] = ["workspace", "watch", "history", "settings"];
const ACTIVE_STATUSES = ["planning", "needs_input", "awaiting_approval", "running"];

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
    props.initialRuns.find((r) => ACTIVE_STATUSES.includes(r.status))?.id ?? null,
  );
  const [runs, setRuns] = useState(props.initialRuns);
  const [tiers, setTiers] = useState<Tier[]>(server.enabled_tiers);
  const [snapshot, setSnapshot] = useState<GuildSnapshot | null>(null);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [botRoleOk, setBotRoleOk] = useState(server.bot_role_ok);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = server.status === "connected";
  const feed = useWatchFeed(server.guild_id);
  const [toast, setToast] = useState<typeof feed.latest>(null);
  const [unseen, setUnseen] = useState(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // A new flag pops up (and counts on the WATCH key) unless you're already looking at the log.
  useEffect(() => {
    if (!feed.latest || tabRef.current === "watch") return;
    setToast(feed.latest);
    setUnseen((n) => n + 1);
  }, [feed.latest]);
  useEffect(() => {
    if (tab === "watch") {
      setUnseen(0);
      setToast(null);
    }
  }, [tab]);
  const closeToast = useCallback(() => setToast(null), []);
  const channelName = useCallback((id: string) => snapshot?.channels.find((c) => c.id === id)?.name ?? null, [snapshot]);

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

  // The rack shows live tier changes for the current server.
  const rackServers = props.servers.map((s) => (s.id === server.id ? { ...s, enabled_tiers: tiers, bot_role_ok: botRoleOk } : s));

  return (
    <div className="mx-auto grid max-w-7xl items-start gap-4 px-4 pb-16 md:grid-cols-[250px_minmax(0,1fr)]">
      <ServerRack servers={rackServers} currentId={server.id} />

      <section className="chassis screws grid min-w-0 gap-4 px-4 pb-5 pt-7 sm:px-5">
        {/* Plate, status and mode keys */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="plate flex min-w-0 items-center gap-3 py-2 pl-2 pr-4">
            <ServerIcon name={server.name} icon={server.icon} size={38} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-extrabold tracking-tight">{server.name}</h1>
              <div className="font-mono text-[10px] text-muted">
                {server.guild_id}
                {snapshot ? ` · ${snapshot.memberCount} members` : ""}
              </div>
            </div>
          </div>
          <StatusPill status={server.status} roleOk={botRoleOk} />
          <nav className="flex w-full gap-1.5 rounded-xl border border-line bg-well p-1.5 sm:ml-auto sm:w-auto" aria-label="Panel">
            {TABS.map((t) => (
              <button key={t} className="mode-key relative flex-1 sm:flex-none" aria-pressed={tab === t} onClick={() => setTab(t)}>
                <span
                  className={`led led-sm ${tab === t ? "led-accent" : t === "watch" && unseen > 0 ? "led-danger" : t === "watch" && feed.watches.some((w) => w.status === "active") && tiers.includes("live_watch") ? "led-ok" : ""}`}
                  aria-hidden
                />
                {t}
                {t === "watch" && unseen > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[9px] text-white">
                    {unseen > 9 ? "9+" : unseen}
                    <span className="sr-only"> new flags</span>
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {props.justConnected && (
          <div className="strip strip-ok">
            <span className="led led-ok" aria-hidden />
            <p className="flex-1">Whispcord is connected. Try a prompt below.</p>
          </div>
        )}
        {!botRoleOk && connected && (
          <div className="strip strip-warn">
            <span className="led led-warn" aria-hidden />
            <p className="min-w-[200px] flex-1">
              Drag the <strong>Whispcord</strong> role near the top of your role list (Server Settings → Roles) so it can manage your other roles.
            </p>
            <button className="btn" onClick={checkBot}>Check again</button>
          </div>
        )}
        {!connected && (
          <div className="strip strip-danger">
            <span className="led led-danger" aria-hidden />
            <p className="min-w-[200px] flex-1">Whispcord is disconnected from this server. Nothing can be planned or run until you connect it again.</p>
            <Link href="/servers" className="btn-primary">Reconnect</Link>
          </div>
        )}

        {tab === "workspace" && (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="grid min-w-0 gap-4">
              <div className="well grid gap-2.5 p-3 focus-within:border-[#2f5b49]">
                <label htmlFor="prompt" className="label-caps text-[#4f8a70]">Command input</label>
                <textarea
                  id="prompt"
                  className="min-h-24 w-full resize-y bg-transparent font-mono text-[13.5px] leading-relaxed text-phosphor caret-phosphor outline-none placeholder:text-[#3f6a57]"
                  placeholder={connected
                    ? "Describe what you want, e.g. “Create a Gaming category with general, clips and LFG text channels and a Squad voice channel.”"
                    : "Reconnect this server to send commands."}
                  value={prompt}
                  disabled={!connected}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) void startRun(prompt);
                  }}
                  maxLength={4000}
                />
                <div className="flex flex-wrap items-center gap-2">
                  {PRESETS.map(([label, text]) => (
                    <button key={label} className="cartridge" title={text} disabled={!connected} onClick={() => setPrompt(text)}>
                      {label}
                    </button>
                  ))}
                  <button
                    className="btn-primary w-full sm:ml-auto sm:w-auto"
                    disabled={busy || !prompt.trim() || !connected}
                    onClick={() => startRun(prompt)}
                  >
                    {busy ? "Starting…" : "Plan it"}
                  </button>
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
              </div>

              {activeRunId ? (
                <RunThread key={activeRunId} runId={activeRunId} onChanged={onRunChanged} onOpenRun={openRun} />
              ) : (
                <p className="px-1 text-sm text-muted">Your plan will appear here. Nothing changes on your server until you press RUN.</p>
              )}
            </div>

            <ServerMirror snapshot={snapshot} error={mirrorError} onRefresh={refreshMirror} connected={connected} />
          </div>
        )}

        {tab === "watch" && (
          <WatchPanel
            feed={feed}
            enabled={tiers.includes("live_watch")}
            connected={connected}
            channelName={channelName}
            onPlan={(p) => void startRun(p)}
            onSetUp={() => {
              setPrompt(WATCH_PROMPT);
              setTab("workspace");
            }}
          />
        )}

        {tab === "history" && <History runs={runs} serverName={server.name} onOpen={openRun} />}

        {tab === "settings" && <Settings server={server} isOwner={props.isOwner} tiers={tiers} setTiers={setTiers} />}
      </section>
      <FlagToast flag={toast} onClose={closeToast} onView={() => setTab("watch")} />
    </div>
  );
}

/* ---------------- Server rack ---------------- */

function ServerRack({ servers, currentId }: { servers: ServerInfo[]; currentId: string }) {
  const online = servers.filter((s) => s.status === "connected").length;
  return (
    <aside className="chassis screws grid gap-2.5 px-3 pb-3 pt-7 md:sticky md:top-4" aria-label="Your servers">
      <div className="flex items-baseline justify-between px-1">
        <span className="label-caps">Server rack</span>
        <span className="label-caps">{online}/{servers.length} online</span>
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1 md:grid md:overflow-visible md:pb-0">
        {servers.map((s) => {
          const st = serverState(s.status, s.bot_role_ok);
          return (
            <li key={s.id} className="min-w-[210px] md:min-w-0">
              <Link href={`/servers/${s.guild_id}`} className="rack-unit" aria-current={s.id === currentId ? "page" : undefined}>
                <ServerIcon name={s.name} icon={s.icon} size={34} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate font-semibold">{s.name}</span>
                  <span className={`font-mono text-[9.5px] tracking-[0.12em] ${st.tone}`}>{st.short}</span>
                  <span className="mt-0.5"><TierPips tiers={s.enabled_tiers} /></span>
                </span>
                <span className={`led ${st.led}`} role="img" aria-label={st.label} />
              </Link>
            </li>
          );
        })}
        <li className="min-w-[210px] md:min-w-0">
          <Link href="/servers" className="empty-slot flex items-center justify-between gap-2 p-3 hover:border-accent">
            <span className="label-caps">Empty slot</span>
            <span className="font-mono text-[11px] font-bold tracking-[0.1em] text-accent-hi">+ CONNECT</span>
          </Link>
        </li>
      </ul>
    </aside>
  );
}

/* ---------------- Server structure ---------------- */

function ServerMirror({ snapshot, error, onRefresh, connected }: {
  snapshot: GuildSnapshot | null; error: string | null; onRefresh: () => void; connected: boolean;
}) {
  return (
    <aside className="well scanlines grid h-fit min-w-0 gap-3 p-3" aria-label="Server structure">
      <div className="flex items-center justify-between">
        <span className="label-caps">Server structure</span>
        <button className="btn-ghost px-2 py-1 text-[10px]" onClick={onRefresh}>Refresh</button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!snapshot && !error && (
        <p className="grid min-h-40 place-items-center rounded-lg font-mono text-xs tracking-[0.2em] text-dim">
          {connected ? "LOADING…" : "NO SIGNAL"}
        </p>
      )}
      {snapshot && <MirrorBody s={snapshot} />}
    </aside>
  );
}

function MirrorBody({ s }: { s: GuildSnapshot }) {
  const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  const cats = s.channels.filter((c) => c.type === "CATEGORY").sort(byPos);
  const loose = s.channels.filter((c) => c.type !== "CATEGORY" && !c.parentId).sort(byPos);
  const roles = [...s.roles].filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position);
  const channelCount = s.channels.filter((c) => c.type !== "CATEGORY").length;
  const glyph = (type: string) => (type === "VOICE" || type === "STAGE" ? "◉" : type === "FORUM" ? "≡" : "#");
  const Channel = ({ c }: { c: GuildSnapshot["channels"][number] }) => (
    <li className="flex items-center gap-1.5 rounded px-1.5 py-px text-[#c9cdd8]">
      <span className="w-2.5 text-center text-dim" aria-hidden>{glyph(c.type)}</span>
      <span className="truncate">{c.name}</span>
    </li>
  );
  return (
    <div className="grid gap-3 font-mono text-xs">
      <div className="grid grid-cols-3 gap-1.5">
        {([[s.memberCount, "MEMBERS"], [channelCount, "CHANNELS"], [roles.length, "ROLES"]] as const).map(([n, label]) => (
          <div key={label} className="grid rounded-lg border border-[#232833] bg-[#12151b] px-2 py-1.5">
            <b className="text-base tabular-nums text-phosphor">{n}</b>
            <span className="text-[9px] tracking-[0.12em] text-muted">{label}</span>
          </div>
        ))}
      </div>
      <ul className="grid gap-px">
        {loose.map((c) => <Channel key={c.id} c={c} />)}
        {cats.map((cat) => (
          <li key={cat.id} className="mt-2">
            <div className="text-[10.5px] tracking-[0.12em] text-muted uppercase">{cat.name}</div>
            <ul className="mt-0.5 grid gap-px">
              {s.channels.filter((c) => c.parentId === cat.id).sort(byPos).map((c) => <Channel key={c.id} c={c} />)}
            </ul>
          </li>
        ))}
      </ul>
      <div className="grid gap-1.5">
        <span className="label-caps">Roles</span>
        <ul className="flex flex-wrap gap-1.5">
          {roles.map((r) => {
            const color = r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "#8b93a7";
            const above = r.position >= s.botHighestRolePosition && !r.managed;
            return (
              <li
                key={r.id}
                className={`rounded-full border px-2 py-0.5 text-[10.5px] ${above ? "opacity-60" : ""}`}
                style={{ color, borderColor: `${color}55` }}
                title={above ? "At or above Whispcord's role, so Whispcord can't change it" : undefined}
              >
                @{r.name}{r.managed ? " · bot" : ""}{above ? " · locked" : ""}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ---------------- History: run recorder ---------------- */

const RUN_LIGHT: Record<string, string> = {
  done: "led-ok", failed: "led-danger", planning: "led-busy", needs_input: "led-busy", awaiting_approval: "led-busy", running: "led-busy",
};

function History({ runs, serverName, onOpen }: { runs: RunSummary[]; serverName: string; onOpen: (id: string) => void }) {
  const done = runs.filter((r) => r.status === "done").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  return (
    <div className="well overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-[#2b313d] px-4 py-2.5">
        <span className="label-caps">Run recorder · {serverName}</span>
        <span className="flex gap-4 font-mono text-[11px] text-muted">
          <span><b className="text-text">{runs.length}</b> runs</span>
          <span><b className="text-text">{done}</b> done</span>
          <span><b className="text-text">{failed}</b> failed</span>
        </span>
      </div>
      {runs.length === 0 && <p className="p-4 text-sm text-muted">No runs yet. Your first plan will be recorded here.</p>}
      <ul>
        {runs.map((r) => (
          <li key={r.id} className="border-b border-[#191d24] last:border-b-0">
            <button
              className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-[#12161c] sm:grid-cols-[120px_60px_minmax(0,1fr)_150px]"
              onClick={() => onOpen(r.id)}
            >
              <span className="font-mono text-[11px] tabular-nums text-muted">
                {new Date(r.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <span className={`hidden justify-self-start rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold tracking-[0.12em] uppercase sm:inline ${
                r.kind === "undo" ? "border-warn/40 text-warn" : r.kind === "fix" ? "border-phosphor/35 text-phosphor" : "border-accent/40 text-accent-hi"
              }`}>
                {r.kind === "prompt" ? "Plan" : r.kind}
              </span>
              <span className="col-span-2 row-start-2 min-w-0 truncate sm:col-span-1 sm:row-start-auto">{r.prompt}</span>
              <span className="col-start-2 row-start-1 flex items-center gap-2 font-mono text-[10px] tracking-[0.1em] uppercase sm:col-start-auto sm:row-start-auto">
                <span className={`led ${RUN_LIGHT[r.status] ?? ""}`} aria-hidden />
                {r.status.replace("_", " ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------- Settings deck ---------------- */

const TIER_LABELS: Record<string, [string, string]> = {
  build: ["Build", "Create and edit channels, categories, roles, permissions, webhooks, events, invites and emojis."],
  destructive: ["Deletions", "Allow plans that delete things. Each one still needs you to type DELETE."],
  moderate: ["Moderation", "Assign roles, nicknames, timeouts, kicks and bans. Requires the Builder + Moderation bot permissions."],
  messaging: ["Messaging", "Send, edit and react to messages in channels."],
  message_search: [
    "Message search",
    "Find messages that match a description, like “hateful messages this week”. Recent message text is sent to Anthropic (Claude) to check it; matches are kept in run history for 30 days. Needs Discord’s Message Content intent.",
  ],
  live_watch: [
    "Live watch",
    "Watch new messages as they’re posted and flag the ones that match, like “hurtful messages”. While a watch runs, every new message in its channels is sent to Anthropic (Claude) to check it; flags are kept for 30 days. A watch can auto-delete high-severity matches only if Deletions is on and you type DELETE when approving it. Tell your members in your server rules. Needs Discord’s Message Content intent.",
  ],
};

const MODULE_CAPTIONS: Record<string, string> = {
  build: "Channels, roles, permissions, events",
  destructive: "Each one needs typed DELETE",
  moderate: "Roles, timeouts, kicks, bans",
  messaging: "Send, edit, react",
  message_search: "Checks message text with Claude",
  live_watch: "Flags new messages as they arrive",
};

function Settings({ server, isOwner, tiers, setTiers }: {
  server: ServerInfo; isOwner: boolean; tiers: Tier[]; setTiers: (t: Tier[]) => void;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsUpgrade, setNeedsUpgrade] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const coverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (coverTimer.current) clearTimeout(coverTimer.current); }, []);

  function closeCoverIn(ms: number) {
    if (coverTimer.current) clearTimeout(coverTimer.current);
    coverTimer.current = setTimeout(() => setCoverOpen(false), ms);
  }

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

  function flip(t: Tier) {
    const on = !tiers.includes(t);
    void save(on ? [...tiers, t] : tiers.filter((x) => x !== t));
    if (t === "destructive") closeCoverIn(900);
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
    try {
      await api(`/servers/${server.guild_id}/disconnect`, { method: "POST", body: {} });
      window.location.href = "/servers";
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const armed = DECK_TIERS.filter((d) => USER_TOGGLEABLE_TIERS.includes(d.tier) && tiers.includes(d.tier));

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
      <section className="grid gap-3.5 rounded-[14px] border border-[#333949] bg-gradient-to-b from-[#1c2029] to-[#14171d] p-4" aria-labelledby="deck-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="deck-title" className="label-caps">What Whispcord may do here</h2>
          <span className="label-caps">{armed.length} armed</span>
        </div>
        {!isOwner && <p className="text-sm text-muted">Only the person who connected this server can change these.</p>}

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 2xl:grid-cols-7">
          {DECK_TIERS.filter((d) => USER_TOGGLEABLE_TIERS.includes(d.tier)).map((d) => {
            const on = tiers.includes(d.tier);
            const guarded = d.tier === "destructive";
            const lever = (
              <button
                role="switch"
                aria-checked={on}
                aria-label={TIER_LABELS[d.tier]?.[0] ?? d.tier}
                className="lever"
                disabled={!isOwner || (guarded && !coverOpen)}
                tabIndex={guarded && !coverOpen ? -1 : undefined}
                onClick={() => flip(d.tier)}
              >
                <span className="lever-knob" />
              </button>
            );
            const lightOn = guarded ? "led-danger" : "led-ok";
            return (
              <div key={d.tier} className="deck-module">
                <span className="module-plate">{d.short}</span>
                <span className={`led ${on ? lightOn : ""}`} aria-hidden />
                {guarded ? (
                  <div className={`cover-wrap ${coverOpen ? "is-open" : ""}`}>
                    <button
                      className="safety-cover"
                      aria-label="Lift the safety cover to change Deletions"
                      disabled={!isOwner}
                      tabIndex={coverOpen ? -1 : undefined}
                      onClick={() => { setCoverOpen(true); closeCoverIn(5000); }}
                    >
                      LIFT
                    </button>
                    {lever}
                  </div>
                ) : lever}
                <p className="min-h-[3.1em] text-center text-[11.5px] leading-snug text-muted">{MODULE_CAPTIONS[d.tier]}</p>
              </div>
            );
          })}
          <div className="deck-module is-sealed" aria-label="Direct messages and user lookups are never available">
            <span className="module-plate">DMs</span>
            <span className="led" aria-hidden />
            <span className="lever opacity-55" aria-hidden><span className="lever-knob" /></span>
            <span className="weld" aria-hidden>SEALED</span>
            <span className="screw left-1.5 top-1.5" /><span className="screw right-1.5 top-1.5" />
            <span className="screw bottom-1.5 left-1.5" /><span className="screw bottom-1.5 right-1.5" />
            <p className="min-h-[3.1em] text-center text-[11.5px] leading-snug text-muted">DMs and user lookups. Never.</p>
          </div>
        </div>

        {needsUpgrade && (
          <div className="strip strip-warn">
            <span className="led led-warn" aria-hidden />
            <p className="min-w-[200px] flex-1">Moderation needs extra bot permissions (kick, ban, timeout, nicknames). Discord will ask you to approve them.</p>
            <button className="btn-primary" onClick={upgradePermissions}>Grant moderation permissions</button>
          </div>
        )}

        <div className="grid min-h-[58px] gap-0.5 rounded-lg border border-[#262b35] bg-[#07090c] px-3 py-2.5 font-mono text-xs text-ok" aria-live="polite">
          <span>&gt; ARMED: {armed.length ? armed.map((a) => a.short).join(" · ") : "NONE (read only)"}</span>
          {tiers.includes("destructive")
            ? <span className="text-warn">&gt; DELETE ARMED: each deletion asks you to type DELETE</span>
            : <span className="text-dim">&gt; DELETE SAFE: plans cannot delete anything</span>}
          {saved && <span>&gt; {saved.toUpperCase()}</span>}
          {error && <span className="text-danger">&gt; {error}</span>}
        </div>

        <dl className="grid gap-2 border-t border-line pt-3 text-[12.5px] sm:grid-cols-2">
          {USER_TOGGLEABLE_TIERS.map((t) => (
            <div key={t}>
              <dt className="font-semibold">{TIER_LABELS[t]?.[0] ?? t}</dt>
              <dd className="text-muted">{TIER_LABELS[t]?.[1]}</dd>
            </div>
          ))}
          <div>
            <dt className="font-semibold">Direct messages and user lookups</dt>
            <dd className="text-muted">Never available through Whispcord.</dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-2.5 rounded-[14px] border border-[#333949] bg-gradient-to-b from-[#1c2029] to-[#14171d] p-4" aria-labelledby="disconnect-title">
        <h2 id="disconnect-title" className="label-caps text-danger">Disconnect</h2>
        <p className="text-[13px] text-muted">Stops Whispcord from acting on this server. To remove the bot entirely, kick it in Discord.</p>
        <HoldButton label="Hold to disconnect" disabled={!isOwner} onConfirm={disconnect} />
      </section>
    </div>
  );
}

/** A button you hold for 1.5 seconds. Replaces a confirm() dialog for disconnecting. */
function HoldButton({ label, disabled, onConfirm }: { label: string; disabled?: boolean; onConfirm: () => void }) {
  const fill = useRef<HTMLSpanElement>(null);
  const raf = useRef(0);
  const start = useRef(0);
  const done = useRef(false);

  const stop = () => {
    cancelAnimationFrame(raf.current);
    start.current = 0;
    if (fill.current && !done.current) fill.current.style.transform = "scaleX(0)";
  };
  const tick = (ts: number) => {
    if (!start.current) start.current = ts;
    const p = Math.min(1, (ts - start.current) / 1500);
    if (fill.current) fill.current.style.transform = `scaleX(${p})`;
    if (p >= 1) {
      done.current = true;
      onConfirm();
    } else raf.current = requestAnimationFrame(tick);
  };
  const begin = () => {
    if (disabled || done.current) return;
    stop();
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      className="hold-btn disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); begin(); }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); begin(); } }}
      onKeyUp={stop}
    >
      <span ref={fill} className="hold-fill" style={{ transform: "scaleX(0)" }} />
      <span className="relative">{label.toUpperCase()}</span>
    </button>
  );
}
