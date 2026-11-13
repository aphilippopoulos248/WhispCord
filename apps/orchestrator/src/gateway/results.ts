/**
 * discord-mcp returns prose, not JSON. These helpers pull the IDs Whispcord needs for
 * placeholders and undo out of the known response formats.
 */
export function extractCreatedId(tool: string, text: string): string | null {
  if (tool === "create_webhook") {
    return text.match(/\/webhooks\/(\d{17,20})\//)?.[1] ?? null;
  }
  if (tool === "start_live_watch") {
    return text.match(/\(Watch ID: ([0-9a-f-]{36})\)/)?.[1] ?? null;
  }
  if (tool === "create_invite") {
    return text.match(/discord\.gg\/([A-Za-z0-9-]+)/)?.[1] ?? null;
  }
  return text.match(/\(ID: (\d{17,20})\)/)?.[1] ?? null;
}

export interface Overwrite {
  type: "role" | "member";
  id: string;
  allow: string;
  deny: string;
}

/** Parses list_channel_permission_overwrites output. */
export function parseOverwrites(text: string): Overwrite[] {
  const out: Overwrite[] = [];
  const re = /- \*\*(Role|Member): .*?\*\* \(ID: (\d+)\)\s*\n\s*• Allow: (\d+).*\n\s*• Deny: (\d+)/g;
  for (const m of text.matchAll(re)) {
    out.push({ type: m[1] === "Role" ? "role" : "member", id: m[2]!, allow: m[3]!, deny: m[4]! });
  }
  return out;
}

/** Parses get_channel_info output ("Key: value" lines). */
export function parseChannelInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z ]+):\s?(.*)$/);
    if (m) out[m[1]!.trim()] = m[2]!.trim();
  }
  return out;
}
