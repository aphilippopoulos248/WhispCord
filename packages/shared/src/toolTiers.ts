/**
 * Tool allowlist. Every discord-mcp tool Whispcord may use is listed here with its tier.
 * Anything NOT listed is blocked by default, so new upstream tools never appear silently.
 */
export const TIERS = ["read", "build", "destructive", "moderate", "messaging", "message_search", "restricted"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Tiers a server owner may toggle. `restricted` (DMs, user lookups) is never user-enabled.
 * `message_search` sends message text to Anthropic for classification, so it is off by default.
 */
export const USER_TOGGLEABLE_TIERS: Tier[] = ["build", "destructive", "moderate", "messaging", "message_search"];
export const DEFAULT_ENABLED_TIERS: Tier[] = ["read", "build", "destructive"];

/**
 * What kind of Discord object an argument refers to. The gateway validates that every
 * reference belongs to the run's guild.
 */
export type RefKind =
  | "channel" // any guild channel, incl. categories
  | "channelList" // comma-separated channel IDs; each must be a channel in this guild
  | "category"
  | "role"
  | "member"
  | "emoji"
  | "event"
  | "webhook" // only IDs created during this run (or undone)
  | "invite" // only codes created during this run (or undone)
  | "message"; // scoped by a validated channelId

export type CreatedObjectType = "category" | "channel" | "role" | "webhook" | "event" | "invite" | "emoji";

export interface ToolSpec {
  tier: Tier;
  /** Arguments that reference Discord objects and must belong to the run's guild. */
  refs?: Record<string, RefKind>;
  /** Set when the tool creates an object; drives undo. */
  creates?: CreatedObjectType;
  /** Builds the inverse action for undo, given the created object's id. */
  inverse?: (createdId: string) => { tool: string; args: Record<string, string> };
  /** Tool used to snapshot before-state for edits (args are derived from the edit's args). */
  snapshotWith?: { tool: string; pick: string[] };
  /**
   * False for tools only the orchestrator calls on Claude's behalf (e.g. scan_messages, used by
   * find_messages). They never appear in the action catalog and can't be plan steps.
   */
  plannable?: boolean;
  /** UI grouping. */
  group: "server" | "category" | "channel" | "role" | "permission" | "webhook" | "event" | "invite" | "emoji" | "message" | "member" | "moderation";
}

const del = (tool: string, arg: string) => (id: string) => ({ tool, args: { [arg]: id } });

export const TOOL_SPECS: Record<string, ToolSpec> = {
  // ---- read ----
  get_server_info: { tier: "read", group: "server" },
  list_channels: { tier: "read", group: "channel" },
  find_channel: { tier: "read", group: "channel" },
  get_channel_info: { tier: "read", group: "channel", refs: { channelId: "channel" } },
  find_category: { tier: "read", group: "category" },
  list_channels_in_category: { tier: "read", group: "category", refs: { categoryId: "category" } },
  list_roles: { tier: "read", group: "role" },
  list_channel_permission_overwrites: { tier: "read", group: "permission", refs: { channelId: "channel" } },
  list_emojis: { tier: "read", group: "emoji" },
  get_emoji_details: { tier: "read", group: "emoji", refs: { emojiId: "emoji" } },
  list_forum_channels: { tier: "read", group: "channel" },
  get_forum_channel_info: { tier: "read", group: "channel", refs: { channelId: "channel" } },
  list_forum_tags: { tier: "read", group: "channel", refs: { channelId: "channel" } },
  list_forum_posts: { tier: "read", group: "channel", refs: { channelId: "channel" } },
  list_invites: { tier: "read", group: "invite" },
  list_guild_scheduled_events: { tier: "read", group: "event" },
  list_webhooks: { tier: "read", group: "webhook", refs: { channelId: "channel" } },
  list_threads: { tier: "read", group: "channel", refs: { channelId: "channel" } },
  list_active_threads: { tier: "read", group: "channel" },

  // ---- build ----
  create_category: {
    tier: "build", group: "category", creates: "category",
    inverse: del("delete_category", "categoryId"),
  },
  edit_category: {
    tier: "build", group: "category", refs: { categoryId: "category" },
    snapshotWith: { tool: "get_channel_info", pick: ["categoryId->channelId"] },
  },
  create_text_channel: {
    tier: "build", group: "channel", refs: { categoryId: "category" }, creates: "channel",
    inverse: del("delete_channel", "channelId"),
  },
  edit_text_channel: {
    tier: "build", group: "channel", refs: { channelId: "channel" },
    snapshotWith: { tool: "get_channel_info", pick: ["channelId"] },
  },
  move_channel: {
    tier: "build", group: "channel", refs: { channelId: "channel" },
    snapshotWith: { tool: "get_channel_info", pick: ["channelId"] },
  },
  create_voice_channel: {
    tier: "build", group: "channel", refs: { categoryId: "category" }, creates: "channel",
    inverse: del("delete_channel", "channelId"),
  },
  create_stage_channel: {
    tier: "build", group: "channel", refs: { categoryId: "category" }, creates: "channel",
    inverse: del("delete_channel", "channelId"),
  },
  edit_voice_channel: {
    tier: "build", group: "channel", refs: { channelId: "channel" },
    snapshotWith: { tool: "get_channel_info", pick: ["channelId"] },
  },
  create_forum_channel: {
    tier: "build", group: "channel", refs: { categoryId: "category" }, creates: "channel",
    inverse: del("delete_channel", "channelId"),
  },
  edit_forum_channel: {
    tier: "build", group: "channel", refs: { channelId: "channel" },
    snapshotWith: { tool: "get_forum_channel_info", pick: ["channelId"] },
  },
  create_role: {
    tier: "build", group: "role", creates: "role",
    inverse: del("delete_role", "roleId"),
  },
  edit_role: { tier: "build", group: "role", refs: { roleId: "role" } },
  upsert_role_channel_permissions: {
    tier: "build", group: "permission", refs: { channelId: "channel", roleId: "role" },
    snapshotWith: { tool: "list_channel_permission_overwrites", pick: ["channelId"] },
  },
  upsert_member_channel_permissions: {
    tier: "build", group: "permission", refs: { channelId: "channel", userId: "member" },
    snapshotWith: { tool: "list_channel_permission_overwrites", pick: ["channelId"] },
  },
  create_webhook: {
    tier: "build", group: "webhook", refs: { channelId: "channel" }, creates: "webhook",
    inverse: del("delete_webhook", "webhookId"),
  },
  create_guild_scheduled_event: {
    tier: "build", group: "event", creates: "event",
    inverse: del("delete_guild_scheduled_event", "eventId"),
  },
  edit_guild_scheduled_event: { tier: "build", group: "event", refs: { eventId: "event" } },
  create_invite: {
    tier: "build", group: "invite", refs: { channelId: "channel" }, creates: "invite",
    inverse: del("delete_invite", "inviteCode"),
  },
  create_emoji: {
    tier: "build", group: "emoji", creates: "emoji",
    inverse: del("delete_emoji", "emojiId"),
  },
  edit_emoji: { tier: "build", group: "emoji", refs: { emojiId: "emoji" } },

  // ---- destructive (never undoable; typed confirmation required) ----
  delete_category: { tier: "destructive", group: "category", refs: { categoryId: "category" } },
  delete_channel: { tier: "destructive", group: "channel", refs: { channelId: "channel" } },
  delete_role: { tier: "destructive", group: "role", refs: { roleId: "role" } },
  delete_channel_permission_overwrite: {
    tier: "destructive", group: "permission", refs: { channelId: "channel" },
    snapshotWith: { tool: "list_channel_permission_overwrites", pick: ["channelId"] },
  },
  delete_webhook: { tier: "destructive", group: "webhook", refs: { webhookId: "webhook" } },
  delete_guild_scheduled_event: { tier: "destructive", group: "event", refs: { eventId: "event" } },
  delete_invite: { tier: "destructive", group: "invite", refs: { inviteCode: "invite" } },
  delete_emoji: { tier: "destructive", group: "emoji", refs: { emojiId: "emoji" } },
  // Deleted messages are gone for good, so they need the same typed confirmation as other deletions.
  delete_message: { tier: "destructive", group: "message", refs: { channelId: "channel", messageId: "message" } },

  // ---- message search (opt-in; message text goes to a tool-less classifier, never the planner) ----
  scan_messages: { tier: "message_search", group: "message", refs: { channelIds: "channelList" }, plannable: false },

  // ---- moderate (opt-in) ----
  assign_role: { tier: "moderate", group: "member", refs: { userId: "member", roleId: "role" } },
  remove_role: { tier: "moderate", group: "member", refs: { userId: "member", roleId: "role" } },
  kick_member: { tier: "moderate", group: "moderation", refs: { userId: "member" } },
  ban_member: { tier: "moderate", group: "moderation", refs: { userId: "member" } },
  unban_member: { tier: "moderate", group: "moderation" },
  timeout_member: { tier: "moderate", group: "moderation", refs: { userId: "member" } },
  remove_timeout: { tier: "moderate", group: "moderation", refs: { userId: "member" } },
  set_nickname: { tier: "moderate", group: "member", refs: { userId: "member" } },
  get_bans: { tier: "moderate", group: "moderation" },
  search_members: { tier: "moderate", group: "member" },
  get_member_by_id: { tier: "moderate", group: "member", refs: { userId: "member" } },
  move_member: { tier: "moderate", group: "member", refs: { userId: "member", channelId: "channel" } },
  disconnect_member: { tier: "moderate", group: "member", refs: { userId: "member" } },
  modify_voice_state: { tier: "moderate", group: "member", refs: { userId: "member" } },

  // ---- messaging (opt-in) ----
  send_message: { tier: "messaging", group: "message", refs: { channelId: "channel" } },
  edit_message: { tier: "messaging", group: "message", refs: { channelId: "channel", messageId: "message" } },
  read_messages: { tier: "messaging", group: "message", refs: { channelId: "channel" } },
  add_reaction: { tier: "messaging", group: "message", refs: { channelId: "channel", messageId: "message" } },
  remove_reaction: { tier: "messaging", group: "message", refs: { channelId: "channel", messageId: "message" } },
  create_forum_post: { tier: "messaging", group: "message", refs: { channelId: "channel" } },

  // ---- restricted (never exposed to users) ----
  send_private_message: { tier: "restricted", group: "message" },
  edit_private_message: { tier: "restricted", group: "message" },
  delete_private_message: { tier: "restricted", group: "message" },
  read_private_messages: { tier: "restricted", group: "message" },
  get_user_id_by_name: { tier: "restricted", group: "member" },
};

/** Whispcord-internal tools from the fork. The orchestrator calls these; Claude never sees them. */
export const INTERNAL_TOOLS = ["check_member_permissions", "get_bot_status", "get_guild_snapshot"] as const;

export function toolSpec(name: string): ToolSpec | undefined {
  return Object.prototype.hasOwnProperty.call(TOOL_SPECS, name) ? TOOL_SPECS[name] : undefined;
}

export function isToolAllowed(name: string, enabledTiers: readonly Tier[]): boolean {
  const spec = toolSpec(name);
  if (!spec || spec.tier === "restricted") return false;
  return spec.tier === "read" || enabledTiers.includes(spec.tier);
}

/** Can this tool appear as a step in a plan (and in Claude's action catalog)? */
export function isPlannable(name: string): boolean {
  const spec = toolSpec(name);
  return spec !== undefined && spec.tier !== "read" && spec.plannable !== false;
}

export const isDestructive = (name: string) => toolSpec(name)?.tier === "destructive";
export const isWrite = (name: string) => {
  const t = toolSpec(name)?.tier;
  return t !== undefined && t !== "read";
};
