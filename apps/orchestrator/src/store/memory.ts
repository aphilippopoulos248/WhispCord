import { randomUUID } from "node:crypto";
import { DEFAULT_ENABLED_TIERS, type LiveFlag, type LiveWatch } from "@whispcord/shared";
import type { ConnectAttempt, NewWatch, Profile, Run, RunAction, Server, Store } from "./types.js";

/** In-memory store for the CLI, local experiments and tests. */
export class MemoryStore implements Store {
  profiles = new Map<string, Profile & { authUserId: string }>();
  servers = new Map<string, Server>();
  members = new Set<string>();
  attempts = new Map<string, ConnectAttempt>();
  runs = new Map<string, Run>();
  actions = new Map<string, RunAction>();
  watches = new Map<string, LiveWatch>();
  flags = new Map<string, LiveFlag>();

  addProfile(p: Profile & { authUserId: string }) {
    this.profiles.set(p.id, p);
  }

  async getProfileByAuthUser(authUserId: string) {
    return [...this.profiles.values()].find((p) => p.authUserId === authUserId) ?? null;
  }
  async setManageableGuilds(profileId: string, guilds: Profile["manageableGuilds"]) {
    const p = this.profiles.get(profileId);
    if (p) p.manageableGuilds = guilds;
  }

  async getServerByGuildId(guildId: string) {
    return this.servers.get(guildId) ?? null;
  }
  async getServerById(id: string) {
    return [...this.servers.values()].find((s) => s.id === id) ?? null;
  }
  async upsertConnectedServer(input: { guildId: string; name: string; icon: string | null; profileId: string; botRoleOk: boolean }) {
    const existing = this.servers.get(input.guildId);
    const server: Server = {
      id: existing?.id ?? randomUUID(),
      guildId: input.guildId,
      name: input.name,
      icon: input.icon,
      ownerProfileId: existing?.ownerProfileId ?? input.profileId,
      status: "connected",
      enabledTiers: existing?.enabledTiers ?? [...DEFAULT_ENABLED_TIERS],
      botRoleOk: input.botRoleOk,
      connectedAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
    };
    this.servers.set(input.guildId, server);
    this.members.add(`${server.id}:${input.profileId}`);
    return server;
  }
  async updateServer(guildId: string, patch: Partial<Server>) {
    const s = this.servers.get(guildId);
    if (!s) return;
    if (patch.status && patch.status !== s.status) s.statusChangedAt = new Date().toISOString();
    Object.assign(s, patch);
  }
  async isServerMember(serverId: string, profileId: string) {
    return this.members.has(`${serverId}:${profileId}`);
  }
  async removeServerMember(serverId: string, profileId: string) {
    this.members.delete(`${serverId}:${profileId}`);
  }

  async createConnectAttempt(input: { profileId: string; guildId: string; state: string; expiresAt: Date }) {
    this.attempts.set(input.state, {
      id: randomUUID(), profileId: input.profileId, guildId: input.guildId, state: input.state,
      expiresAt: input.expiresAt.toISOString(), usedAt: null,
    });
  }
  async consumeConnectAttempt(state: string) {
    const a = this.attempts.get(state);
    if (!a || a.usedAt || new Date(a.expiresAt) < new Date()) return null;
    a.usedAt = new Date().toISOString();
    return { ...a };
  }

  async createRun(input: { serverId: string; profileId: string; kind: Run["kind"]; parentRunId?: string | null; prompt: string; model: string }) {
    const run: Run = {
      id: randomUUID(), serverId: input.serverId, profileId: input.profileId, kind: input.kind,
      parentRunId: input.parentRunId ?? null, prompt: input.prompt, status: "planning", plan: null,
      conversation: null, pendingQuestion: null, approvedStepIds: null, report: null, messageSearch: null, error: null, model: input.model,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    return run;
  }
  async getRun(id: string) {
    const r = this.runs.get(id);
    return r ? structuredClone(r) : null;
  }
  async updateRun(id: string, patch: Partial<Run>) {
    const r = this.runs.get(id);
    if (r) Object.assign(r, patch);
  }
  async countRunsSince(serverId: string, since: Date) {
    return [...this.runs.values()].filter((r) => r.serverId === serverId && new Date(r.createdAt) >= since).length;
  }

  async countRunsByProfileSince(profileId: string, since: Date) {
    return [...this.runs.values()].filter((r) => r.profileId === profileId && new Date(r.createdAt) >= since).length;
  }
  async failInterruptedRuns(message: string) {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.status === "planning" || r.status === "running") {
        r.status = "failed";
        r.error = message;
        n++;
      }
    }
    return n;
  }

  async insertAction(input: Omit<RunAction, "id">) {
    const a: RunAction = { ...input, id: randomUUID() };
    this.actions.set(a.id, a);
    return { ...a };
  }
  async updateAction(id: string, patch: Partial<RunAction>) {
    const a = this.actions.get(id);
    if (a) Object.assign(a, patch);
  }
  async listActions(runId: string) {
    return [...this.actions.values()].filter((a) => a.runId === runId).sort((a, b) => a.stepIndex - b.stepIndex).map((a) => ({ ...a }));
  }

  async recordUsage() {}

  async createWatch(input: NewWatch) {
    const w: LiveWatch = { ...input, id: randomUUID(), status: "active", createdAt: new Date().toISOString(), stoppedAt: null };
    this.watches.set(w.id, w);
    return { ...w };
  }
  async getWatch(id: string) {
    const w = this.watches.get(id);
    return w ? { ...w } : null;
  }
  async listWatches(serverId: string, limit = 20) {
    return [...this.watches.values()].filter((w) => w.serverId === serverId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((w) => ({ ...w }));
  }
  async listActiveWatches() {
    return [...this.watches.values()].filter((w) => w.status === "active").map((w) => ({ ...w }));
  }
  async stopWatch(id: string) {
    const w = this.watches.get(id);
    if (w && w.status === "active") Object.assign(w, { status: "stopped", stoppedAt: new Date().toISOString() });
  }
  async insertFlag(input: Omit<LiveFlag, "id" | "flaggedAt">) {
    if ([...this.flags.values()].some((f) => f.watchId === input.watchId && f.messageId === input.messageId)) return null;
    const f: LiveFlag = { ...input, id: randomUUID(), flaggedAt: new Date().toISOString() };
    this.flags.set(f.id, f);
    return { ...f };
  }
  async getFlag(id: string) {
    const f = this.flags.get(id);
    return f ? { ...f } : null;
  }
  async updateFlag(id: string, patch: Pick<LiveFlag, "action"> & Partial<Pick<LiveFlag, "actionError">>) {
    const f = this.flags.get(id);
    if (!f) return null;
    Object.assign(f, patch);
    return { ...f };
  }
  async listFlags(serverId: string, limit: number) {
    return [...this.flags.values()].filter((f) => f.serverId === serverId)
      .sort((a, b) => b.flaggedAt.localeCompare(a.flaggedAt)).slice(0, limit).map((f) => ({ ...f }));
  }
  async purgeFlagsBefore(before: Date) {
    let n = 0;
    for (const [id, f] of this.flags) {
      if (new Date(f.flaggedAt) < before) {
        this.flags.delete(id);
        n++;
      }
    }
    return n;
  }

  async listConnectedServers() {
    return [...this.servers.values()].filter((s) => s.status === "connected");
  }
  async purgeDisconnectedServers(before: Date) {
    let n = 0;
    for (const [guildId, s] of this.servers) {
      if (s.status === "disconnected" && s.statusChangedAt && new Date(s.statusChangedAt) < before) {
        this.deleteServer(s.id);
        this.servers.delete(guildId);
        n++;
      }
    }
    return n;
  }
  async clearMessageSearchBefore(before: Date) {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.messageSearch && new Date(r.createdAt) < before) {
        r.messageSearch = null;
        n++;
      }
    }
    return n;
  }
  async purgeExpiredConnectAttempts() {
    let n = 0;
    for (const [state, a] of this.attempts) {
      if (new Date(a.expiresAt) < new Date()) {
        this.attempts.delete(state);
        n++;
      }
    }
    return n;
  }
  async deleteAccount(profileId: string) {
    for (const [guildId, s] of this.servers) {
      if (s.ownerProfileId === profileId) {
        this.deleteServer(s.id);
        this.servers.delete(guildId);
      }
    }
    for (const [id, r] of this.runs) if (r.profileId === profileId) this.deleteRun(id);
    for (const [id, w] of this.watches) {
      if (w.createdBy !== profileId) continue;
      this.watches.delete(id);
      for (const [fid, f] of this.flags) if (f.watchId === id) this.flags.delete(fid);
    }
    for (const key of this.members) if (key.endsWith(`:${profileId}`)) this.members.delete(key);
    for (const [state, a] of this.attempts) if (a.profileId === profileId) this.attempts.delete(state);
    this.profiles.delete(profileId);
  }

  private deleteRun(id: string) {
    this.runs.delete(id);
    for (const [aid, a] of this.actions) if (a.runId === id) this.actions.delete(aid);
  }
  private deleteServer(serverId: string) {
    for (const [id, r] of this.runs) if (r.serverId === serverId) this.deleteRun(id);
    for (const [id, w] of this.watches) if (w.serverId === serverId) this.watches.delete(id);
    for (const [id, f] of this.flags) if (f.serverId === serverId) this.flags.delete(id);
    for (const key of this.members) if (key.startsWith(`${serverId}:`)) this.members.delete(key);
  }
}
