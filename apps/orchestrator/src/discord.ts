import { canManageGuild, parsePermissions } from "@whispcord/shared";
import type { ManageableGuild } from "./store/types.js";

const API = "https://discord.com/api/v10";

interface DiscordPartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

/**
 * Uses the user's Discord OAuth token (handed to us once at sign-in) to list the servers they
 * can manage. This is only a pre-check for the picker; the bot's live check is authoritative.
 */
export async function fetchManageableGuilds(providerToken: string, expectedDiscordUserId: string): Promise<ManageableGuild[]> {
  const headers = { Authorization: `Bearer ${providerToken}` };
  const meRes = await fetch(`${API}/users/@me`, { headers });
  if (!meRes.ok) throw new Error(`Discord /users/@me failed: HTTP ${meRes.status}`);
  const me = (await meRes.json()) as { id: string };
  // Prevent syncing someone else's guild list onto this profile.
  if (me.id !== expectedDiscordUserId) throw new Error("Discord token does not belong to this account.");

  const res = await fetch(`${API}/users/@me/guilds`, { headers });
  if (!res.ok) throw new Error(`Discord /users/@me/guilds failed: HTTP ${res.status}`);
  const guilds = (await res.json()) as DiscordPartialGuild[];
  return guilds
    .filter((g) => canManageGuild(parsePermissions(g.permissions), g.owner))
    .map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
      owner: g.owner,
    }));
}
