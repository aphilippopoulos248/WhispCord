/**
 * Discord permission bits (https://discord.com/developers/docs/topics/permissions).
 * BigInt because several flags sit above 2^31 and the full bitfield exceeds 2^53.
 */
export const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  MANAGE_EVENTS: 1n << 33n,
  MANAGE_THREADS: 1n << 34n,
  MODERATE_MEMBERS: 1n << 40n,
} as const;

const or = (...bits: bigint[]) => bits.reduce((a, b) => a | b, 0n);

/** Default bot tier. Deliberately excludes Administrator. */
export const BUILDER_PERMISSIONS = or(
  P.VIEW_CHANNEL,
  P.SEND_MESSAGES,
  P.READ_MESSAGE_HISTORY,
  P.MANAGE_CHANNELS,
  P.MANAGE_ROLES,
  P.MANAGE_WEBHOOKS,
  P.MANAGE_GUILD_EXPRESSIONS,
  P.MANAGE_EVENTS,
  P.MANAGE_THREADS,
  P.CREATE_INSTANT_INVITE,
);

/** Opt-in tier: Builder plus moderation. */
export const MODERATION_PERMISSIONS = or(
  BUILDER_PERMISSIONS,
  P.KICK_MEMBERS,
  P.BAN_MEMBERS,
  P.MANAGE_NICKNAMES,
  P.MODERATE_MEMBERS,
);

export function parsePermissions(raw: string | number | bigint | null | undefined): bigint {
  if (raw === null || raw === undefined || raw === "") return 0n;
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid permission bitfield: ${String(raw)}`);
  }
}

export function hasPermission(perms: bigint, bit: bigint): boolean {
  if ((perms & P.ADMINISTRATOR) === P.ADMINISTRATOR) return true;
  return (perms & bit) === bit;
}

/** True when every bit in `requested` is also in `held` (Administrator holds everything). */
export function isSubset(requested: bigint, held: bigint): boolean {
  if ((held & P.ADMINISTRATOR) === P.ADMINISTRATOR) return true;
  return (requested & ~held) === 0n;
}

/** A guild member can manage a server if they own it, are admin, or hold Manage Server. */
export function canManageGuild(perms: bigint, isOwner: boolean): boolean {
  return isOwner || hasPermission(perms, P.MANAGE_GUILD);
}

export function buildBotInviteUrl(opts: {
  clientId: string;
  guildId: string;
  redirectUri: string;
  state: string;
  permissions?: bigint;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    scope: "bot applications.commands",
    permissions: (opts.permissions ?? BUILDER_PERMISSIONS).toString(),
    guild_id: opts.guildId,
    disable_guild_select: "true",
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const SNOWFLAKE_RE = /^\d{17,20}$/;
export const isSnowflake = (v: unknown): v is string => typeof v === "string" && SNOWFLAKE_RE.test(v);
