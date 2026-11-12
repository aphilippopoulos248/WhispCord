import Link from "next/link";
import { ConnectServer } from "@/components/ConnectServer";
import { DeleteAccount } from "@/components/DeleteAccount";
import { ServerIcon } from "@/components/ServerIcon";
import { StatusPill } from "@/components/StatusPill";
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
}

async function loadData(): Promise<{ manageable: Array<{ id: string; name: string; icon: string | null }>; connected: ServerRow[] }> {
  if (isDemo) return { manageable: demoManageable, connected: demoServers };
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const [{ data: profile }, { data: servers }] = await Promise.all([
    supabase.from("profiles").select("manageable_guilds").eq("id", auth.user!.id).maybeSingle(),
    supabase.from("servers").select("id, guild_id, name, icon, status, bot_role_ok").order("name"),
  ]);
  return {
    manageable: (profile?.manageable_guilds ?? []) as Array<{ id: string; name: string; icon: string | null }>,
    connected: (servers ?? []) as ServerRow[],
  };
}

export default async function ServersPage() {
  const { manageable, connected } = await loadData();
  const connectedIds = new Set(connected.filter((s) => s.status === "connected").map((s) => s.guild_id));

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Your servers</h1>

      {connected.length > 0 && (
        <div className="mt-6 grid gap-3">
          {connected.map((s) => (
            <Link key={s.id} href={`/servers/${s.guild_id}`} className="card flex items-center gap-3 p-4 hover:border-accent">
              <ServerIcon name={s.name} icon={s.icon} />
              <div className="flex-1">
                <div className="font-medium">{s.name}</div>
                <div className="text-xs text-muted">{s.guild_id}</div>
              </div>
              <StatusPill status={s.status} roleOk={s.bot_role_ok} />
            </Link>
          ))}
        </div>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-medium">Connect a server</h2>
        <p className="mt-1 text-sm text-muted">
          You need <strong>Manage Server</strong> on the server. Whispcord adds its bot with only the permissions it needs (no Administrator).
        </p>
        <ConnectServer manageable={manageable.filter((g) => !connectedIds.has(g.id))} />
      </section>

      <section className="mt-16 border-t border-line pt-6">
        <h2 className="text-sm font-medium text-muted">Account</h2>
        <DeleteAccount />
      </section>
    </div>
  );
}

