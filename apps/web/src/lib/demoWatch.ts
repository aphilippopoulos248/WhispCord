"use client";

import type { LiveFlag, LiveWatch, WatchEvent } from "@whispcord/shared";
import { DEMO_GUILD_ID } from "./demoData";

/**
 * Demo-mode live watch: one running watch on Pixel Raiders that "flags" a sample message every
 * so often, so the WATCH panel can be seen without Discord or Claude.
 */

const watches = new Map<string, LiveWatch[]>([
  [DEMO_GUILD_ID, [{
    id: "00000000-0000-4000-8000-00000000d001", serverId: "demo-server-1", runId: null, createdBy: "demo-user",
    createdByDiscordId: "400000000000000001", criteria: "hurtful or harassing messages", channelIds: [], autoDelete: false,
    status: "active", createdAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(), stoppedAt: null,
  }]],
]);
const flags = new Map<string, LiveFlag[]>();
const listeners = new Map<string, Set<(e: WatchEvent) => void>>();
let seq = 0;

const SAMPLES: Array<Pick<LiveFlag, "channelName" | "authorName" | "severity" | "reason" | "excerpt">> = [
  { channelName: "general", authorName: "nightowl_88", severity: "high", reason: "Repeated insults aimed at another member.", excerpt: "(sample) you're worthless, nobody wants you here" },
  { channelName: "memes", authorName: "rexxie", severity: "medium", reason: "Mocks a member's appearance.", excerpt: "(sample) lol look at this clown's face" },
  { channelName: "general", authorName: "byte_me", severity: "low", reason: "Dismissive, mildly rude reply.", excerpt: "(sample) nobody asked, go away" },
];

function makeFlag(guildId: string, watchId: string): LiveFlag {
  const s = SAMPLES[seq % SAMPLES.length]!;
  seq++;
  const messageId = (900000000000000000n + BigInt(seq)).toString();
  return {
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`, watchId, serverId: "demo-server-1", messageId,
    channelId: "900000000000000006", authorId: "400000000000000099", postedAt: new Date().toISOString(),
    jumpUrl: `https://discord.com/channels/${guildId}/900000000000000006/${messageId}`, action: "none", actionError: null,
    flaggedAt: new Date().toISOString(), ...s,
  };
}

// Two earlier flags so the log isn't empty on first load.
for (let i = 0; i < 2; i++) {
  const f = makeFlag(DEMO_GUILD_ID, "00000000-0000-4000-8000-00000000d001");
  f.flaggedAt = new Date(Date.now() - 1000 * 60 * (30 - i * 12)).toISOString();
  flags.set(DEMO_GUILD_ID, [f, ...(flags.get(DEMO_GUILD_ID) ?? [])]);
}

function emit(guildId: string, e: WatchEvent) {
  for (const l of listeners.get(guildId) ?? []) l(e);
}

/** Handles the watch routes, or returns undefined for anything else. */
export function demoWatchApi(path: string): unknown {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/servers\/(\d+)\/watch$/))) {
    return { watches: watches.get(m[1]!) ?? [], flags: flags.get(m[1]!) ?? [], paused: null };
  }
  if ((m = path.match(/^\/servers\/(\d+)\/watches\/([\w-]+)\/stop$/))) {
    const [, guildId, watchId] = m;
    const list = watches.get(guildId!) ?? [];
    for (const w of list) if (w.id === watchId) Object.assign(w, { status: "stopped", stoppedAt: new Date().toISOString() });
    emit(guildId!, { type: "watches", watches: list });
    return { ok: true };
  }
  if ((m = path.match(/^\/servers\/(\d+)\/flags\/([\w-]+)\/dismiss$/))) {
    const [, guildId, flagId] = m;
    const flag = (flags.get(guildId!) ?? []).find((f) => f.id === flagId);
    if (!flag) throw new Error("Flag not found.");
    flag.action = "dismissed";
    emit(guildId!, { type: "flag_updated", flag });
    return { flag };
  }
  return undefined;
}

export function demoSubscribeWatch(guildId: string, onEvent: (e: WatchEvent) => void): () => void {
  const set = listeners.get(guildId) ?? new Set();
  set.add(onEvent);
  listeners.set(guildId, set);
  const timer = setInterval(() => {
    const active = (watches.get(guildId) ?? []).find((w) => w.status === "active");
    if (!active) return;
    const flag = makeFlag(guildId, active.id);
    flags.set(guildId, [flag, ...(flags.get(guildId) ?? [])].slice(0, 100));
    onEvent({ type: "flag", flag });
  }, 20000);
  return () => {
    clearInterval(timer);
    set.delete(onEvent);
  };
}
