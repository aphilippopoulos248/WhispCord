import { toolSpec, type GuildSnapshot } from "@whispcord/shared";
import { parseChannelInfo, parseOverwrites } from "../gateway/results.js";
import type { InverseAction } from "../store/types.js";

/** Args for the before-state snapshot call of an edit, or null if the tool has none. */
export function beforeSnapshotCall(tool: string, args: Record<string, string>): { tool: string; args: Record<string, string> } | null {
  const spec = toolSpec(tool);
  if (!spec?.snapshotWith) return null;
  const out: Record<string, string> = {};
  for (const pick of spec.snapshotWith.pick) {
    const [from, to] = pick.split("->") as [string, string | undefined];
    const v = args[from];
    if (v === undefined) return null;
    out[to ?? from] = v;
  }
  return { tool: spec.snapshotWith.tool, args: out };
}

/**
 * The action that reverses a successful step, or null when it can't be undone
 * (deletions, messages, and edits whose before-state we couldn't capture).
 */
export function buildInverse(input: {
  tool: string;
  args: Record<string, string>;
  createdId: string | null;
  before: string | null;
  snapshot: GuildSnapshot;
}): InverseAction | null {
  const { tool, args, createdId, before, snapshot } = input;
  const spec = toolSpec(tool);
  if (spec?.creates && spec.inverse && createdId) return spec.inverse(createdId);

  switch (tool) {
    case "upsert_role_channel_permissions":
    case "upsert_member_channel_permissions":
    case "delete_channel_permission_overwrite": {
      if (before === null) return null;
      const targetId = tool === "upsert_role_channel_permissions" ? args.roleId
        : tool === "upsert_member_channel_permissions" ? args.userId : args.targetId;
      const targetType = tool === "upsert_role_channel_permissions" ? "role"
        : tool === "upsert_member_channel_permissions" ? "member" : args.targetType;
      if (!targetId || !args.channelId) return null;
      const prior = parseOverwrites(before).find((o) => o.id === targetId);
      if (!prior) {
        if (tool === "delete_channel_permission_overwrite") return null; // nothing existed
        return { tool: "delete_channel_permission_overwrite", args: { channelId: args.channelId, targetType: targetType!, targetId } };
      }
      return prior.type === "role"
        ? { tool: "upsert_role_channel_permissions", args: { channelId: args.channelId, roleId: prior.id, allowRaw: prior.allow, denyRaw: prior.deny } }
        : { tool: "upsert_member_channel_permissions", args: { channelId: args.channelId, userId: prior.id, allowRaw: prior.allow, denyRaw: prior.deny } };
    }

    case "edit_text_channel":
    case "edit_voice_channel":
    case "move_channel":
    case "edit_category": {
      if (before === null) return null;
      const info = parseChannelInfo(before);
      const idArg = tool === "edit_category" ? "categoryId" : "channelId";
      const out: Record<string, string> = { [idArg]: args[idArg]! };
      if (args.name !== undefined && info.Name !== undefined) out.name = info.Name;
      if (args.position !== undefined && info.Position !== undefined) out.position = info.Position;
      if (tool === "move_channel") {
        if (info.Position === undefined) return null;
        out.position = info.Position;
      }
      if (tool === "edit_text_channel") {
        if (args.topic !== undefined && info.Topic !== undefined) out.topic = info.Topic === "none" ? "" : info.Topic;
        if (args.nsfw !== undefined && info.NSFW !== undefined) out.nsfw = info.NSFW;
      }
      if (tool === "edit_voice_channel" && args.bitrate !== undefined && info.Bitrate !== undefined) out.bitrate = info.Bitrate;
      return Object.keys(out).length > 1 ? { tool, args: out } : null;
    }

    case "edit_role": {
      const role = snapshot.roles.find((r) => r.id === args.roleId);
      if (!role) return null;
      const out: Record<string, string> = { roleId: role.id };
      if (args.name !== undefined) out.name = role.name;
      if (args.color !== undefined) out.color = String(role.color);
      if (args.hoist !== undefined) out.hoist = String(role.hoisted);
      if (args.permissions !== undefined) out.permissions = role.permissions;
      return Object.keys(out).length > 1 ? { tool, args: out } : null;
    }

    case "edit_emoji": {
      const emoji = snapshot.emojis.find((e) => e.id === args.emojiId);
      if (!emoji || args.name === undefined) return null;
      return { tool, args: { emojiId: emoji.id, name: emoji.name } };
    }

    case "assign_role":
      return { tool: "remove_role", args: { userId: args.userId!, roleId: args.roleId! } };
    case "remove_role":
      return { tool: "assign_role", args: { userId: args.userId!, roleId: args.roleId! } };
  }
  return null;
}
