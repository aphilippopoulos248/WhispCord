import { z } from "zod";

/** Shape returned by the fork's get_guild_snapshot tool. */
export const GuildSnapshotSchema = z.object({
  guildId: z.string(),
  name: z.string(),
  icon: z.string().nullable().optional(),
  ownerId: z.string(),
  memberCount: z.number(),
  botHighestRolePosition: z.number(),
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      parentId: z.string().nullable(),
      position: z.number(),
    }),
  ),
  roles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      position: z.number(),
      color: z.number(),
      permissions: z.string(),
      managed: z.boolean(),
      isEveryone: z.boolean(),
      hoisted: z.boolean(),
    }),
  ),
  emojis: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  events: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type GuildSnapshot = z.infer<typeof GuildSnapshotSchema>;

export const MemberPermissionsSchema = z.object({
  guildId: z.string(),
  userId: z.string(),
  botInGuild: z.boolean(),
  isMember: z.boolean(),
  isOwner: z.boolean().default(false),
  isAdministrator: z.boolean().default(false),
  canManageServer: z.boolean(),
  canManageRoles: z.boolean().default(false),
  canManageChannels: z.boolean().default(false),
  permissions: z.string().default("0"),
  highestRolePosition: z.number().default(0),
});
export type MemberPermissions = z.infer<typeof MemberPermissionsSchema>;

export const BotStatusSchema = z.object({
  guildId: z.string().nullable(),
  inGuild: z.boolean(),
  guildName: z.string().optional(),
  guildIcon: z.string().nullable().optional(),
  ownerId: z.string().optional(),
  memberCount: z.number().optional(),
  botUserId: z.string().optional(),
  highestRolePosition: z.number().optional(),
  maxOtherRolePosition: z.number().optional(),
  rolesAboveBot: z.number().optional(),
  permissions: z.string().optional(),
  missingPermissions: z.array(z.string()).optional(),
  isAdministrator: z.boolean().optional(),
});
export type BotStatus = z.infer<typeof BotStatusSchema>;

/** The bot's role is "high enough" when no non-managed role sits above it. */
export function botRoleOk(status: BotStatus): boolean {
  return status.inGuild && (status.rolesAboveBot ?? 0) === 0 && (status.missingPermissions ?? []).length === 0;
}

/**
 * Compact, model-friendly rendering of the guild. Names and IDs only; everything here is
 * untrusted user data and is passed to Claude as data, not instructions.
 */
export function renderSnapshotForModel(s: GuildSnapshot): string {
  const byParent = new Map<string | null, GuildSnapshot["channels"]>();
  for (const c of s.channels) {
    if (c.type === "CATEGORY") continue;
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  const sortPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;
  const lines: string[] = [`Server: ${JSON.stringify(s.name)} (members: ${s.memberCount})`, "", "Channels:"];
  for (const c of (byParent.get(null) ?? []).sort(sortPos)) {
    lines.push(`- [${c.type}] ${JSON.stringify(c.name)} id=${c.id}`);
  }
  for (const cat of s.channels.filter((c) => c.type === "CATEGORY").sort(sortPos)) {
    lines.push(`- [CATEGORY] ${JSON.stringify(cat.name)} id=${cat.id}`);
    for (const c of (byParent.get(cat.id) ?? []).sort(sortPos)) {
      lines.push(`  - [${c.type}] ${JSON.stringify(c.name)} id=${c.id}`);
    }
  }
  lines.push("", "Roles (highest first):");
  for (const r of [...s.roles].sort((a, b) => b.position - a.position)) {
    const flags = [r.managed ? "managed" : null, r.isEveryone ? "@everyone" : null].filter(Boolean).join(",");
    lines.push(`- ${JSON.stringify(r.name)} id=${r.id} position=${r.position} permissions=${r.permissions}${flags ? ` (${flags})` : ""}`);
  }
  lines.push(`Bot's highest role position: ${s.botHighestRolePosition} (it can only manage roles below this).`);
  if (s.emojis.length) lines.push("", "Emojis: " + s.emojis.map((e) => `${JSON.stringify(e.name)} id=${e.id}`).join(", "));
  if (s.events.length) lines.push("", "Scheduled events: " + s.events.map((e) => `${JSON.stringify(e.name)} id=${e.id}`).join(", "));
  return lines.join("\n");
}
