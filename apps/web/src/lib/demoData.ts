import type { GuildSnapshot, Tier } from "@whispcord/shared";

/**
 * Demo mode: `npm run demo:web`. Shows the UI with sample data and a simulated backend.
 * No Supabase, orchestrator, Discord or Anthropic calls are made.
 */
export const isDemo = process.env.NEXT_PUBLIC_WHISPCORD_DEMO === "1";

export const DEMO_GUILD_ID = "123456789012345678";

export const demoServers = [
  {
    id: "demo-server-1",
    guild_id: DEMO_GUILD_ID,
    name: "Pixel Raiders",
    icon: null,
    status: "connected",
    bot_role_ok: true,
    enabled_tiers: ["read", "build", "destructive"] as Tier[],
    owner_profile_id: "demo-user",
  },
  {
    id: "demo-server-2",
    guild_id: "223456789012345678",
    name: "Study Hall",
    icon: null,
    status: "connected",
    bot_role_ok: false,
    enabled_tiers: ["read", "build"] as Tier[],
    owner_profile_id: "demo-user",
  },
];

export const demoManageable = [{ id: "323456789012345678", name: "Weekend Book Club", icon: null }];

export const demoRuns = [
  {
    id: "demo-run-old",
    kind: "prompt",
    prompt: "Add a #rules channel at the top and make it read-only for everyone",
    status: "done",
    created_at: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    parent_run_id: null,
  },
];

export function demoSnapshot(guildId: string): GuildSnapshot {
  const id = (n: number) => `9000000000000000${String(n).padStart(2, "0")}`;
  return {
    guildId,
    name: demoServers.find((s) => s.guild_id === guildId)?.name ?? "Demo Server",
    icon: null,
    ownerId: "400000000000000001",
    memberCount: 142,
    botHighestRolePosition: 6,
    channels: [
      { id: id(1), name: "rules", type: "TEXT", parentId: null, position: 0 },
      { id: id(2), name: "Info", type: "CATEGORY", parentId: null, position: 1 },
      { id: id(3), name: "announcements", type: "TEXT", parentId: id(2), position: 0 },
      { id: id(4), name: "welcome", type: "TEXT", parentId: id(2), position: 1 },
      { id: id(5), name: "Community", type: "CATEGORY", parentId: null, position: 2 },
      { id: id(6), name: "general", type: "TEXT", parentId: id(5), position: 0 },
      { id: id(7), name: "memes", type: "TEXT", parentId: id(5), position: 1 },
      { id: id(8), name: "Hangout", type: "VOICE", parentId: id(5), position: 2 },
    ],
    roles: [
      { id: guildId, name: "@everyone", position: 0, color: 0, permissions: "1024", managed: false, isEveryone: true, hoisted: false },
      { id: id(20), name: "Member", position: 1, color: 0x8b93a7, permissions: "3072", managed: false, isEveryone: false, hoisted: false },
      { id: id(21), name: "Moderator", position: 4, color: 0x3ccf91, permissions: "8192", managed: false, isEveryone: false, hoisted: true },
      { id: id(22), name: "Whispcord", position: 6, color: 0x8b7cf6, permissions: "27648920593", managed: true, isEveryone: false, hoisted: false },
      { id: id(23), name: "Owner", position: 7, color: 0xf2b44c, permissions: "8", managed: false, isEveryone: false, hoisted: true },
    ],
    emojis: [],
    events: [],
  };
}
