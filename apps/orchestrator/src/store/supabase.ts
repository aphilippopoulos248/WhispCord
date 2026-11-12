import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ConnectAttempt, Profile, Run, RunAction, Server, Store } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const toProfile = (r: Row): Profile => ({
  id: r.id,
  discordUserId: r.discord_user_id,
  username: r.username,
  manageableGuilds: r.manageable_guilds ?? [],
});

const toServer = (r: Row): Server => ({
  id: r.id,
  guildId: r.guild_id,
  name: r.name,
  icon: r.icon,
  ownerProfileId: r.owner_profile_id,
  status: r.status,
  enabledTiers: r.enabled_tiers,
  botRoleOk: r.bot_role_ok,
  connectedAt: r.connected_at,
  statusChangedAt: r.status_changed_at ?? null,
});

const toRun = (r: Row): Run => ({
  id: r.id,
  serverId: r.server_id,
  profileId: r.profile_id,
  kind: r.kind,
  parentRunId: r.parent_run_id,
  prompt: r.prompt,
  status: r.status,
  plan: r.plan_json,
  conversation: r.conversation_json,
  pendingQuestion: r.pending_question_json,
  approvedStepIds: r.approved_step_ids,
  report: r.report ?? null,
  messageSearch: r.message_search_json ?? null,
  error: r.error,
  model: r.model,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens ?? 0,
  cacheWriteTokens: r.cache_write_tokens ?? 0,
  createdAt: r.created_at,
});

const runPatchToRow = (p: Partial<Run>): Row => {
  const map: Record<string, string> = {
    kind: "kind", parentRunId: "parent_run_id", prompt: "prompt", status: "status", plan: "plan_json",
    conversation: "conversation_json", pendingQuestion: "pending_question_json", approvedStepIds: "approved_step_ids", report: "report", messageSearch: "message_search_json",
    error: "error", model: "model", inputTokens: "input_tokens", outputTokens: "output_tokens",
    cacheReadTokens: "cache_read_tokens", cacheWriteTokens: "cache_write_tokens",
  };
  const row: Row = {};
  for (const [k, v] of Object.entries(p)) if (map[k]) row[map[k]] = v;
  return row;
};

const toAction = (r: Row): RunAction => ({
  id: r.id,
  runId: r.run_id,
  stepId: r.step_id,
  stepIndex: r.step_index,
  tool: r.tool,
  args: r.args_json,
  resultText: r.result_text,
  status: r.status,
  error: r.error,
  createdObjectId: r.created_object_id,
  createdObjectType: r.created_object_type,
  beforeSnapshot: r.before_snapshot,
  inverseAction: r.inverse_action_json,
  durationMs: r.duration_ms,
});

const actionToRow = (a: Partial<RunAction>): Row => {
  const map: Record<string, string> = {
    runId: "run_id", stepId: "step_id", stepIndex: "step_index", tool: "tool", args: "args_json",
    resultText: "result_text", status: "status", error: "error", createdObjectId: "created_object_id",
    createdObjectType: "created_object_type", beforeSnapshot: "before_snapshot", inverseAction: "inverse_action_json",
    durationMs: "duration_ms",
  };
  const row: Row = {};
  for (const [k, v] of Object.entries(a)) if (map[k]) row[map[k]] = v;
  return row;
};

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`Supabase: ${res.error.message}`);
  return res.data;
}

/** For `.single()` queries: a missing row is an error. */
function checkOne(res: { data: unknown; error: { message: string } | null }): Row {
  const data = check(res);
  if (data === null || data === undefined) throw new Error("Supabase: expected one row, got none");
  return data as Row;
}

/** Uses the service-role key: RLS is bypassed, so every method enforces its own scoping. */
export class SupabaseStore implements Store {
  readonly db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async getProfileByAuthUser(authUserId: string) {
    const r = check(await this.db.from("profiles").select("*").eq("id", authUserId).maybeSingle());
    return r ? toProfile(r) : null;
  }

  async setManageableGuilds(profileId: string, guilds: Profile["manageableGuilds"]) {
    check(await this.db.from("profiles").update({ manageable_guilds: guilds, guilds_synced_at: new Date().toISOString() }).eq("id", profileId));
  }

  async getServerByGuildId(guildId: string) {
    const r = check(await this.db.from("servers").select("*").eq("guild_id", guildId).maybeSingle());
    return r ? toServer(r) : null;
  }

  async getServerById(id: string) {
    const r = check(await this.db.from("servers").select("*").eq("id", id).maybeSingle());
    return r ? toServer(r) : null;
  }

  async upsertConnectedServer(input: { guildId: string; name: string; icon: string | null; profileId: string; botRoleOk: boolean }) {
    const existing = await this.getServerByGuildId(input.guildId);
    let row: Row;
    if (existing) {
      row = checkOne(
        await this.db.from("servers")
          .update({ name: input.name, icon: input.icon, status: "connected", bot_role_ok: input.botRoleOk, connected_at: new Date().toISOString() })
          .eq("id", existing.id).select("*").single(),
      );
    } else {
      row = checkOne(
        await this.db.from("servers")
          .insert({ guild_id: input.guildId, name: input.name, icon: input.icon, owner_profile_id: input.profileId, status: "connected", bot_role_ok: input.botRoleOk, connected_at: new Date().toISOString() })
          .select("*").single(),
      );
    }
    const server = toServer(row);
    const role = server.ownerProfileId === input.profileId ? "owner" : "editor";
    check(await this.db.from("server_members").upsert({ server_id: server.id, profile_id: input.profileId, role }, { onConflict: "server_id,profile_id" }));
    return server;
  }

  async updateServer(guildId: string, patch: Partial<Server>) {
    const row: Row = {};
    if (patch.status) row.status = patch.status;
    if (patch.enabledTiers) row.enabled_tiers = patch.enabledTiers;
    if (patch.botRoleOk !== undefined) row.bot_role_ok = patch.botRoleOk;
    if (patch.name) row.name = patch.name;
    if (patch.icon !== undefined) row.icon = patch.icon;
    check(await this.db.from("servers").update(row).eq("guild_id", guildId));
  }

  async isServerMember(serverId: string, profileId: string) {
    const r = check(await this.db.from("server_members").select("server_id").eq("server_id", serverId).eq("profile_id", profileId).maybeSingle());
    return Boolean(r);
  }

  async removeServerMember(serverId: string, profileId: string) {
    check(await this.db.from("server_members").delete().eq("server_id", serverId).eq("profile_id", profileId));
  }

  async createConnectAttempt(input: { profileId: string; guildId: string; state: string; expiresAt: Date }) {
    check(await this.db.from("connect_attempts").insert({ profile_id: input.profileId, guild_id: input.guildId, state: input.state, expires_at: input.expiresAt.toISOString() }));
  }

  async consumeConnectAttempt(state: string): Promise<ConnectAttempt | null> {
    // Conditional update makes this single-use even under concurrent callbacks.
    const r = check(
      await this.db.from("connect_attempts")
        .update({ used_at: new Date().toISOString() })
        .eq("state", state).is("used_at", null).gt("expires_at", new Date().toISOString())
        .select("*").maybeSingle(),
    );
    if (!r) return null;
    return { id: r.id, profileId: r.profile_id, guildId: r.guild_id, state: r.state, expiresAt: r.expires_at, usedAt: r.used_at };
  }

  async createRun(input: { serverId: string; profileId: string; kind: Run["kind"]; parentRunId?: string | null; prompt: string; model: string }) {
    const r = checkOne(
      await this.db.from("runs")
        .insert({ server_id: input.serverId, profile_id: input.profileId, kind: input.kind, parent_run_id: input.parentRunId ?? null, prompt: input.prompt, model: input.model, status: "planning" })
        .select("*").single(),
    );
    return toRun(r);
  }

  async getRun(id: string) {
    const r = check(await this.db.from("runs").select("*").eq("id", id).maybeSingle());
    return r ? toRun(r) : null;
  }

  async updateRun(id: string, patch: Partial<Run>) {
    check(await this.db.from("runs").update({ ...runPatchToRow(patch), updated_at: new Date().toISOString() }).eq("id", id));
  }

  async countRunsSince(serverId: string, since: Date) {
    const res = await this.db.from("runs").select("id", { count: "exact", head: true }).eq("server_id", serverId).gte("created_at", since.toISOString());
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.count ?? 0;
  }

  async countRunsByProfileSince(profileId: string, since: Date) {
    const res = await this.db.from("runs").select("id", { count: "exact", head: true }).eq("profile_id", profileId).gte("created_at", since.toISOString());
    if (res.error) throw new Error(`Supabase: ${res.error.message}`);
    return res.count ?? 0;
  }

  async failInterruptedRuns(message: string) {
    const rows = check(
      await this.db.from("runs")
        .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
        .in("status", ["planning", "running"])
        .select("id"),
    );
    return rows?.length ?? 0;
  }

  async insertAction(input: Omit<RunAction, "id">) {
    const r = checkOne(await this.db.from("run_actions").insert(actionToRow(input)).select("*").single());
    return toAction(r);
  }

  async updateAction(id: string, patch: Partial<RunAction>) {
    check(await this.db.from("run_actions").update(actionToRow(patch)).eq("id", id));
  }

  async listActions(runId: string) {
    const rows = check(await this.db.from("run_actions").select("*").eq("run_id", runId).order("step_index", { ascending: true }));
    return (rows ?? []).map(toAction);
  }

  async listConnectedServers() {
    const rows = check(await this.db.from("servers").select("*").eq("status", "connected"));
    return (rows ?? []).map(toServer);
  }

  async purgeDisconnectedServers(before: Date) {
    // runs, run_actions and server_members cascade from servers.
    const rows = check(
      await this.db.from("servers").delete()
        .eq("status", "disconnected").lt("status_changed_at", before.toISOString())
        .select("id"),
    );
    return rows?.length ?? 0;
  }

  async clearMessageSearchBefore(before: Date) {
    const rows = check(
      await this.db.from("runs").update({ message_search_json: null })
        .lt("created_at", before.toISOString()).not("message_search_json", "is", null)
        .select("id"),
    );
    return rows?.length ?? 0;
  }

  async purgeExpiredConnectAttempts() {
    const rows = check(await this.db.from("connect_attempts").delete().lt("expires_at", new Date().toISOString()).select("id"));
    return rows?.length ?? 0;
  }

  async deleteAccount(profileId: string) {
    // Order matters: runs reference profiles without cascade.
    check(await this.db.from("runs").delete().eq("profile_id", profileId));
    // Servers this user connected go with them (cascades their runs, actions and members).
    check(await this.db.from("servers").delete().eq("owner_profile_id", profileId));
    // Deleting the auth user cascades profiles, server_members, connect_attempts and usage.
    const { error } = await this.db.auth.admin.deleteUser(profileId);
    if (error) throw new Error(`Supabase: ${error.message}`);
  }

  async recordUsage(profileId: string, delta: { runs?: number; actions?: number; tokens?: number }) {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    check(await this.db.rpc("increment_usage", {
      p_profile_id: profileId, p_period: period,
      p_runs: delta.runs ?? 0, p_actions: delta.actions ?? 0, p_tokens: delta.tokens ?? 0,
    }));
  }
}
