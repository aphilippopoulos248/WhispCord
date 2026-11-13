/** Live moderation ("watch for hurtful messages and flag them"). */

export const WATCH_STATUSES = ["active", "stopped"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export interface LiveWatch {
  id: string;
  serverId: string;
  /** The run whose approved plan started it. */
  runId: string | null;
  createdBy: string;
  /** Discord user ID of the creator; their permissions are re-checked before every auto-delete. */
  createdByDiscordId: string;
  criteria: string;
  /** Empty means every text channel the bot can read. */
  channelIds: string[];
  /** Delete high-severity matches automatically (needs Deletions on and typed confirmation). */
  autoDelete: boolean;
  status: WatchStatus;
  createdAt: string;
  stoppedAt: string | null;
}

export const FLAG_ACTIONS = ["none", "dismissed", "auto_deleted", "auto_delete_failed"] as const;
export type FlagAction = (typeof FLAG_ACTIONS)[number];

/** One new message a watch matched. Excerpts go to server members only, never to the planner. */
export interface LiveFlag {
  id: string;
  watchId: string;
  serverId: string;
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  postedAt: string;
  severity: "low" | "medium" | "high";
  reason: string;
  excerpt: string;
  jumpUrl: string;
  action: FlagAction;
  actionError: string | null;
  flaggedAt: string;
}

/** Events streamed to the WATCH panel over SSE. */
export type WatchEvent =
  | { type: "flag"; flag: LiveFlag }
  | { type: "flag_updated"; flag: LiveFlag }
  | { type: "watches"; watches: LiveWatch[] }
  | { type: "notice"; level: "info" | "warn"; message: string };
