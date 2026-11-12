import type { Tier } from "@whispcord/shared";
import Link from "next/link";
import { ConnectServer } from "@/components/ConnectServer";
import { DeleteAccount } from "@/components/DeleteAccount";
import { ServerIcon } from "@/components/ServerIcon";
import { serverState } from "@/components/StatusPill";
import { DECK_TIERS } from "@/components/TierPips";
import { demoManageable, demoServers, isDemo } from "@/lib/demoData";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface ServerRow {
  id: string;
  guild_id: string;
  name: string;
  icon: string | null;
  status: string;
  bot_role_ok: boolean;
  enabled_tiers: Tier[] | null;
}

async function loadData(): Promise<{ manageable: Array<{ id: string; name: string; icon: string | null }>; connected: ServerRow[] }> {
  if (isDemo) return { manageable: demoManageable, connected: demoServers };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const [{ data: profile }, { data: servers }] = await Promise.all([
    supabase.from("profiles").select("manageable_guilds").eq("id", auth.user!.id).maybeSingle(),
    supabase.from("servers").select("id, guild_id, name, icon, status, bot_role_ok, enabled_tiers").order("name"),
  ]);
  return {
    manageable: (profile?.manageable_guilds ?? []) as Array<{ id: string; name: string; icon: string | null }>,
    connected: (servers ?? []) as ServerRow[],
  };
}

export default async function ServersPage() {
  const { manageable, connected } = await loadData();
  const connectedIds = new Set(connected.filter((s) => s.status === "connected").map((s) => s.guild_id));
  const online = connected.filter((s) => s.status === "connected").length;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16">
      <section className="chassis screws grid gap-6 px-5 pb-6 pt-8 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="label-caps">Your servers</span>
            <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Server room</h1>
          </div>
          <p className="max-w-[60ch] text-[13.5px] text-muted">
            Every server you’ve connected, with its status light. Green means ready, blinking amber means the bot’s role needs
            moving higher in Discord, and red means Whispcord is disconnected.
          </p>
        </div>

        {connected.length > 0 ? (
          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
            {connected.map((s) => {
              const st = serverState(s.status, s.bot_role_ok);
              const tiers = s.enabled_tiers ?? [];
              return (
                <Link
                  key={s.id}
                  href={`/servers/${s.guild_id}`}
                  className="grid gap-3 rounded-[14px] border border-[#343b49] bg-gradient-to-b from-[#262c37] to-[#1c2129] p-4 shadow-[0_3px_0_#090b0e,inset_0_1px_0_rgb(255_255_255/0.05)] transition hover:-translate-y-0.5 hover:border-accent/60"
                >
                  <div className="flex items-center gap-3">
                    <ServerIcon name={s.name} icon={s.icon} size={44} />
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">{s.name}</h2>
                      <div className="font-mono text-[10px] text-muted">{s.guild_id}</div>
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-2 justify-self-start rounded-lg border border-line bg-well px-2.5 py-1.5 font-mono text-[10.5px] font-bold tracking-[0.12em]">
                    <span className={`led ${st.led}`} aria-hidden />
                    <span className={st.tone}>{st.short}</span>
                    <span className="sr-only">{st.label}</span>
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {DECK_TIERS.map((t) => {
                      const on = tiers.includes(t.tier);
                      return (
                        <span
                          key={t.tier}
                          className="rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-[0.1em]"
                          style={on ? { color: t.color, borderColor: t.color } : { color: "var(--color-dim)", borderColor: "#2a2f3a" }}
                        >
                          {t.short}
                          <span className="sr-only">{on ? " on" : " off"}</span>
                        </span>
                      );
                    })}
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="empty-slot p-6 text-center font-mono text-xs tracking-[0.14em] text-muted">
            NO SERVERS IN THE RACK YET. CONNECT ONE BELOW.
          </p>
        )}

        <p className="font-mono text-[11px] text-muted">{online}/{connected.length} online</p>
      </section>

      <section className="chassis screws mt-5 grid gap-3 px-5 pb-6 pt-8 sm:px-6" aria-labelledby="connect-title">
        <span className="label-caps">Empty slot</span>
        <h2 id="connect-title" className="text-xl font-extrabold">Connect a server</h2>
        <p className="max-w-[70ch] text-[13.5px] text-muted">
          You need <strong className="text-text">Manage Server</strong> on the server. Whispcord adds its bot with only the permissions it needs (no Administrator).
        </p>
        <ConnectServer manageable={manageable.filter((g) => !connectedIds.has(g.id))} />
      </section>

      <section className="mt-10 border-t border-line px-1 pt-6">
        <h2 className="label-caps">Account</h2>
        <DeleteAccount />
      </section>
    </div>
  );
}
