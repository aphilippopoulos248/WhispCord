import type {
  ActionStatus,
  CreatedObjectType,
  RunStatus,
  Tier,
  ValidatedPlan,
} from "@whispcord/shared";

export interface ManageableGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
}

export interface Profile {
  id: string;
  discordUserId: string;
  username: string | null;
  manageableGuilds: ManageableGuild[];
}

export type ServerStatus = "pending" | "connected" | "disconnected";

export interface Server {
  id: string;
  guildId: string;
  name: string;
  icon: string | null;
  ownerProfileId: string;
  status: ServerStatus;
  enabledTiers: Tier[];
  botRoleOk: boolean;
  connectedAt: string | null;
  statusChangedAt: string | null;
}

export interface ConnectAttempt {
  id: string;
  profileId: string;
  guildId: string;
  state: string;
  expiresAt: string;
  usedAt: string | null;
}

export type RunKind = "prompt" | "undo" | "fix";

export interface Run {
  id: string;
  serverId: string;
  profileId: string;
  kind: RunKind;
  parentRunId: string | null;
  prompt: string;
  status: RunStatus;
  plan: ValidatedPlan | null;
  /** Anthropic message history, stored so clarifying answers continue the same conversation. */
  conversation: unknown[] | null;
  pendingQuestion: { toolUseId: string | null; question: string; partialResults: unknown[] } | null;
  approvedStepIds: string[] | null;
  error: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  createdAt: string;
}

export interface InverseAction {
  tool: string;
  args: Record<string, string>;
}

export interface RunAction {
  id: string;
  runId: string;
  stepId: string;
  stepIndex: number;
  tool: string;
  args: Record<string, string>;
  resultText: string | null;
  status: ActionStatus;
  error: string | null;
  createdObjectId: string | null;
  createdObjectType: CreatedObjectType | null;
  beforeSnapshot: string | null;
  inverseAction: InverseAction | null;
  durationMs: number | null;
}

export interface Store {
  getProfileByAuthUser(authUserId: string): Promise<Profile | null>;
  setManageableGuilds(profileId: string, guilds: ManageableGuild[]): Promise<void>;

  getServerByGuildId(guildId: string): Promise<Server | null>;
  getServerById(id: string): Promise<Server | null>;
  upsertConnectedServer(input: {
    guildId: string;
    name: string;
    icon: string | null;
    profileId: string;
    botRoleOk: boolean;
  }): Promise<Server>;
  updateServer(guildId: string, patch: Partial<Pick<Server, "status" | "enabledTiers" | "botRoleOk" | "name" | "icon">>): Promise<void>;
  isServerMember(serverId: string, profileId: string): Promise<boolean>;
  removeServerMember(serverId: string, profileId: string): Promise<void>;

  createConnectAttempt(input: { profileId: string; guildId: string; state: string; expiresAt: Date }): Promise<void>;
  /** Atomically marks the attempt used; returns null if missing, used or expired. */
  consumeConnectAttempt(state: string): Promise<ConnectAttempt | null>;

  createRun(input: { serverId: string; profileId: string; kind: RunKind; parentRunId?: string | null; prompt: string; model: string }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Omit<Run, "id" | "serverId" | "profileId" | "createdAt">>): Promise<void>;
  countRunsSince(serverId: string, since: Date): Promise<number>;
  countRunsByProfileSince(profileId: string, since: Date): Promise<number>;
  /** Marks runs left in planning/running (e.g. by a restart) as failed. Returns how many. */
  failInterruptedRuns(message: string): Promise<number>;

  insertAction(input: Omit<RunAction, "id">): Promise<RunAction>;
  updateAction(id: string, patch: Partial<Omit<RunAction, "id" | "runId">>): Promise<void>;
  listActions(runId: string): Promise<RunAction[]>;

  recordUsage(profileId: string, delta: { runs?: number; actions?: number; tokens?: number }): Promise<void>;

  // ---- maintenance & data deletion ----
  listConnectedServers(): Promise<Server[]>;
  /** Deletes servers disconnected before `before`, with their runs and actions. Returns how many. */
  purgeDisconnectedServers(before: Date): Promise<number>;
  purgeExpiredConnectAttempts(): Promise<number>;
  /**
   * Deletes everything tied to a user: their runs, the servers they connected (with those
   * servers' history), memberships, usage and the profile/auth account itself.
   */
  deleteAccount(profileId: string): Promise<void>;
}
