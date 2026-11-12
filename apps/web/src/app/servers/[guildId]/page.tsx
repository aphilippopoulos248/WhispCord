import { notFound } from "next/navigation";
import { Workspace, type RunSummary, type ServerInfo } from "@/components/Workspace";
import { demoRuns, demoServers, isDemo } from "@/lib/demoData";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ServerPage({
  params,
  searchParams,
}: {
  params: Promise<{ guildId: string }>;
  searchParams: Promise<{ connected?: string }>;
}) {
  const { guildId } = await params;
  const { connected } = await searchParams;

  if (isDemo) {
    const demo = demoServers.find((s) => s.guild_id === guildId);
    if (!demo) notFound();
    return <Workspace server={demo} servers={demoServers} isOwner initialRuns={demo.id === "demo-server-1" ? demoRuns : []} justConnected={false} />;
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();

  // RLS limits both queries to servers this user is a member of.
  const { data: servers } = await supabase
    .from("servers")
    .select("id, guild_id, name, icon, status, bot_role_ok, enabled_tiers, owner_profile_id")
    .order("name");
  const all = (servers ?? []) as Array<ServerInfo & { owner_profile_id: string }>;
  const server = all.find((s) => s.guild_id === guildId);
  if (!server) notFound();

  const { data: runs } = await supabase
    .from("runs")
    .select("id, kind, prompt, status, created_at, parent_run_id")
    .eq("server_id", server.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <Workspace
      server={server}
      servers={all}
      isOwner={server.owner_profile_id === auth.user!.id}
      initialRuns={(runs ?? []) as RunSummary[]}
      justConnected={connected === "1"}
    />
  );
}
