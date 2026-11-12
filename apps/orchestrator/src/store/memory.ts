import { randomUUID } from "node:crypto";
import { DEFAULT_ENABLED_TIERS } from "@whispcord/shared";
import type { ConnectAttempt, Profile, Run, RunAction, Server, Store } from "./types.js";

/** In-memory store for the CLI, local experiments and tests. */
export class MemoryStore implements Store {
  profiles = new Map<string, Profile & { authUserId: string }>();
  servers = new Map<string, Server>();
  members = new Set<string>();
  attempts = new Map<string, ConnectAttempt>();
  runs = new Map<string, Run>();
  actions = new Map<string, RunAction>();

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
    for (const key of this.members) if (key.startsWith(`${serverId}:`)) this.members.delete(key);
  }
}
