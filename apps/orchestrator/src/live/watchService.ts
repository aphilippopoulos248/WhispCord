import { EventEmitter } from "node:events";
import type Anthropic from "@anthropic-ai/sdk";
import {
  P,
  SNOWFLAKE_RE,
  parsePermissions,
  type LiveFlag,
  type LiveWatch,
  type MemberPermissions,
  type WatchEvent,
} from "@whispcord/shared";
import { z } from "zod";
import { classifyBatch } from "../agent/messageFinder.js";
import type { Config } from "../config.js";
import type { LocalTool } from "../gateway/gateway.js";
import type { DiscordMcp, McpToolDef, ToolCallResult, WhispcordInternal } from "../mcp/client.js";
import type { Profile, Server, Store } from "../store/types.js";
import { MAX_IMAGE_BYTES, makeImageFetcher, type FetchedImage, type ImageFetcher } from "./images.js";

/**
 * Live moderation ("flag hurtful messages as they're posted").
 *
 * - A watch is started by an approved plan step (start_live_watch), so a human approves it.
 *   A watch that auto-deletes is a destructive step: Deletions must be on and the owner types DELETE.
 * - discord-mcp forwards new messages only for guilds with an active watch (set_live_watch_guilds);
 *   other servers' messages never leave the bot.
 * - Messages are batched and sent to the same tool-less classifier as message search. Message
 *   text never reaches the planner (security rule 8); flags go to server members in the WATCH panel.
 * - Image attachments are fetched from Discord's CDN only (see images.ts), sent to the classifier
 *   with their message, and never stored. Capped per server per hour (LIVE_WATCH_MAX_IMAGES_PER_HOUR).
 * - Auto-delete is limited to high-severity matches, re-checks the watch creator's permissions
 *   (Manage Server + Manage Messages) before deleting, and is capped per hour.
 */

const snowflake = z.string().regex(SNOWFLAKE_RE);

/** A new message, as posted by the fork's LiveMessageForwarder. */
export const IncomingMessageSchema = z.object({
  type: z.literal("message_create"),
  guildId: snowflake,
  channelId: snowflake,
  /** Set for thread messages, so a watch on a channel also covers its threads. */
  parentChannelId: snowflake.nullable().optional(),
  channelName: z.string().max(200).default(""),
  messageId: snowflake,
  authorId: snowflake,
  authorName: z.string().max(200).default(""),
  createdAt: z.string().max(64),
  content: z.string().max(4000),
  jumpUrl: z.string().url().max(300),
  /** Image attachments as Discord CDN links; fetched (and checked) only when classifying. */
  images: z
    .array(z.object({ url: z.string().url().max(2000), contentType: z.string().max(100), size: z.number().int().nonnegative() }))
    .max(4)
    .default([]),
});
type ParsedMessage = z.infer<typeof IncomingMessageSchema>;
export type IncomingMessage = Omit<ParsedMessage, "images"> & { images?: ParsedMessage["images"] };

const MAX_EXCERPT = 300;
/** Per classifier call, so one request stays well under Anthropic's request size limit. */
const MAX_IMAGES_PER_CALL = 8;
const MAX_IMAGE_BYTES_PER_CALL = 20 * 1024 * 1024;
const IMAGE_FETCH_CONCURRENCY = 4;
const PERMISSION_CACHE_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface LiveWatchDeps {
  store: Store;
  mcp: DiscordMcp;
  internal: WhispcordInternal;
  anthropic: Anthropic | null;
  config: Config;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  /** Downloads an image attachment (tests pass a fake). Defaults to Discord-CDN-only fetch. */
  fetchImage?: ImageFetcher;
}

/** A queued message with its images, once fetched. */
type Queued = IncomingMessage & { images: NonNullable<IncomingMessage["images"]>; fetched?: FetchedImage[] };

interface ActiveServer {
  server: Server;
  watches: LiveWatch[];
}

interface HourWindow {
  start: number;
  classified: number;
  deleted: number;
  images: number;
  warnedClassify: boolean;
  warnedDelete: boolean;
  warnedImages: boolean;
}

/** The text shown in the WATCH log. Images are never stored, only noted ("[2 images]"). */
function excerptFor(msg: Queued): string {
  const n = msg.fetched?.length ?? 0;
  const note = n ? `[${n === 1 ? "image" : `${n} images`}]` : "";
  const text = msg.content.trim();
  if (!note) return text.slice(0, MAX_EXCERPT);
  return text ? `${text.slice(0, MAX_EXCERPT - note.length - 1)} ${note}` : note;
}

const canManageMessages = (p: MemberPermissions) =>
  p.isOwner || p.isAdministrator || (parsePermissions(p.permissions) & P.MANAGE_MESSAGES) !== 0n;

const def = (name: string, description: string, properties: Record<string, string>, required: string[]): McpToolDef => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(Object.entries(properties).map(([k, d]) => [k, { type: "string", description: d }])),
    required,
  },
});

export const LIVE_TOOL_DEFS = {
  list: def("list_live_watches", "List the live watches running on this server (what they look for, which channels, whether they auto-delete).", {}, []),
  start: def(
    "start_live_watch",
    "Start watching new messages as they are posted and flag the ones that match a description (e.g. hurtful, harassing, spam). Flags appear to the administrator in real time. Use when they want ongoing monitoring, not a one-off search.",
    {
      criteria: "What to flag, in the administrator's words, e.g. 'hurtful or harassing messages'.",
      channelIds: "Comma-separated channel IDs to watch. Omit to watch every text channel the bot can read.",
      autoDelete: "\"true\" to also delete high-severity matches automatically. Only when the administrator explicitly asks for automatic deletion; otherwise omit.",
    },
    ["criteria"],
  ),
  stop: def("stop_live_watch", "Stop a running live watch.", { watchId: "The watch ID from list_live_watches." }, ["watchId"]),
};

export class LiveWatchService {
  private active = new Map<string, ActiveServer>();
  private buffers = new Map<string, Queued[]>();
  private readonly fetchImage: ImageFetcher;
  private timers = new Map<string, NodeJS.Timeout>();
  private windows = new Map<string, HourWindow>();
  private permCache = new Map<string, { ok: boolean; at: number }>();
  private emitter = new EventEmitter();
  private interval: NodeJS.Timeout | null = null;
  /** From discord-mcp: null until the first successful sync. */
  contentIntent: boolean | null = null;

  constructor(private readonly d: LiveWatchDeps) {
    this.emitter.setMaxListeners(0);
    this.fetchImage = d.fetchImage ?? makeImageFetcher();
  }

  /** Loads active watches, tells discord-mcp which servers to forward, and re-syncs every minute. */
  async start(): Promise<void> {
    await this.refresh();
    this.interval = setInterval(() => void this.refresh().catch((e: Error) => this.d.log?.warn(`Live watch sync failed: ${e.message}`)), 60_000);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Rebuilds the set of watched servers from the store. Paused when the tier is off or the server is disconnected. */
  async refresh(): Promise<void> {
    const watches = await this.d.store.listActiveWatches();
    const byServer = new Map<string, LiveWatch[]>();
    for (const w of watches) byServer.set(w.serverId, [...(byServer.get(w.serverId) ?? []), w]);
    const next = new Map<string, ActiveServer>();
    for (const [serverId, list] of byServer) {
      const server = await this.d.store.getServerById(serverId);
      if (server && server.status === "connected" && server.enabledTiers.includes("live_watch")) {
        next.set(server.guildId, { server, watches: list });
      }
    }
    this.active = next;
    for (const guildId of [...this.buffers.keys()]) if (!next.has(guildId)) this.buffers.delete(guildId);
    await this.syncBot();
  }

  watchedGuildIds(): string[] {
    return [...this.active.keys()];
  }

  private async syncBot(): Promise<void> {
    try {
      const res = await this.d.mcp.callTool("set_live_watch_guilds", { guildIds: this.watchedGuildIds().join(",") });
      if (res.isError) {
        this.d.log?.warn(`discord-mcp rejected set_live_watch_guilds: ${res.text.slice(0, 200)}`);
        return;
      }
      const parsed = z.object({ messageContentIntent: z.boolean() }).safeParse(JSON.parse(res.text));
      if (parsed.success) this.contentIntent = parsed.data.messageContentIntent;
    } catch (err) {
      this.d.log?.warn(`Couldn't tell discord-mcp which servers to watch: ${(err as Error).message}`);
    }
  }

  // ---------------- events to the browser ----------------

  subscribe(serverId: string, listener: (e: WatchEvent) => void): () => void {
    this.emitter.on(serverId, listener);
    return () => this.emitter.off(serverId, listener);
  }

  private emit(serverId: string, e: WatchEvent) {
    this.emitter.emit(serverId, e);
  }

  private async emitWatches(serverId: string) {
    this.emit(serverId, { type: "watches", watches: await this.d.store.listWatches(serverId) });
  }

  // ---------------- plan tools (run through the guild-locked gateway) ----------------

  /** The orchestrator-local tools for one run. Each handler can only touch `server`. */
  localTools(server: Server, profile: Profile, runId: string | null): LocalTool[] {
    return [
      { def: LIVE_TOOL_DEFS.list, run: async () => this.listTool(server) },
      { def: LIVE_TOOL_DEFS.start, run: async (args) => this.startTool(server, profile, runId, args) },
      { def: LIVE_TOOL_DEFS.stop, run: async (args) => this.stopWatch(server, args.watchId ?? "") },
    ];
  }

  private async listTool(server: Server): Promise<ToolCallResult> {
    const watches = (await this.d.store.listWatches(server.id)).filter((w) => w.status === "active");
    return {
      text: JSON.stringify(watches.map((w) => ({ watchId: w.id, criteria: w.criteria, channelIds: w.channelIds, autoDelete: w.autoDelete, startedAt: w.createdAt }))),
      isError: false,
    };
  }

  private async startTool(server: Server, profile: Profile, runId: string | null, args: Record<string, string>): Promise<ToolCallResult> {
    const err = (text: string): ToolCallResult => ({ text, isError: true });
    const criteria = (args.criteria ?? "").trim();
    if (criteria.length < 3 || criteria.length > 500) return err("Describe what to flag in 3 to 500 characters.");
    const channelIds = (args.channelIds ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    if (channelIds.some((c) => !SNOWFLAKE_RE.test(c))) return err("channelIds must be channel IDs.");
    const autoDelete = (args.autoDelete ?? "").trim().toLowerCase() === "true";

    const running = (await this.d.store.listWatches(server.id)).filter((w) => w.status === "active").length;
    if (running >= this.d.config.LIVE_WATCH_MAX_ACTIVE_PER_SERVER) {
      return err(`This server already has ${running} live watches running (the limit is ${this.d.config.LIVE_WATCH_MAX_ACTIVE_PER_SERVER}). Stop one first.`);
    }
    if (this.contentIntent === false) {
      return err("Discord isn't sending message text to Whispcord's bot, so a watch couldn't check anything. Turn on the Message Content intent (Developer Portal → Bot) and set WHISPCORD_MESSAGE_CONTENT=true for discord-mcp, then restart it.");
    }
    if (autoDelete) {
      // No escalation: you can only have Whispcord delete messages if you could delete them yourself.
      const perms = await this.d.internal.memberPermissions(server.guildId, profile.discordUserId);
      if (!canManageMessages(perms)) return err("You need Manage Messages on this server to let Whispcord delete messages for you.");
      const bot = await this.d.internal.botStatus(server.guildId);
      if (!(bot.isAdministrator || (parsePermissions(bot.permissions ?? "0") & P.MANAGE_MESSAGES) !== 0n)) {
        return err("Whispcord's bot doesn't have Manage Messages here. With Live watch and Deletions switched on, Settings offers “Grant permissions”; approve it in Discord, then try again.");
      }
    }

    const watch = await this.d.store.createWatch({
      serverId: server.id, runId, createdBy: profile.id, createdByDiscordId: profile.discordUserId, criteria, channelIds, autoDelete,
    });
    await this.refresh();
    await this.emitWatches(server.id);
    const scope = channelIds.length ? `${channelIds.length} channel(s)` : "every text channel";
    const paused = server.enabledTiers.includes("live_watch") ? "" : " It is paused until Live watch is switched on in Settings.";
    return {
      text: `Live watch started (Watch ID: ${watch.id}). Watching ${scope} for: ${criteria}.${autoDelete ? " High-severity matches will be deleted automatically." : ""}${paused}`,
      isError: false,
    };
  }

  /** Stops a watch on this server. Also used by the WATCH panel's Stop button. */
  async stopWatch(server: Server, watchId: string): Promise<ToolCallResult> {
    if (!z.string().uuid().safeParse(watchId).success) return { text: "That isn't a watch ID.", isError: true };
    const watch = await this.d.store.getWatch(watchId);
    // Guild lock: a watch from another server looks exactly like one that doesn't exist.
    if (!watch || watch.serverId !== server.id) return { text: "That watch is not part of this server.", isError: true };
    if (watch.status === "stopped") return { text: `Live watch ${watch.id} was already stopped.`, isError: false };
    await this.d.store.stopWatch(watch.id);
    await this.refresh();
    await this.emitWatches(server.id);
    return { text: `Stopped live watch ${watch.id}.`, isError: false };
  }

  // ---------------- WATCH panel ----------------

  async overview(server: Server) {
    const [watches, flags] = await Promise.all([this.d.store.listWatches(server.id), this.d.store.listFlags(server.id, 100)]);
    let paused: string | null = null;
    if (server.status !== "connected") paused = "This server is disconnected.";
    else if (!server.enabledTiers.includes("live_watch")) paused = "Live watch is switched off in Settings, so watches are paused.";
    else if (this.contentIntent === false) paused = "Discord isn't sending message text to the bot (Message Content intent is off), so nothing can be checked.";
    return { watches, flags, paused };
  }

  async dismiss(server: Server, flagId: string): Promise<LiveFlag> {
    const flag = z.string().uuid().safeParse(flagId).success ? await this.d.store.getFlag(flagId) : null;
    if (!flag || flag.serverId !== server.id) throw new Error("Flag not found.");
    const updated = (await this.d.store.updateFlag(flag.id, { action: "dismissed" }))!;
    this.emit(server.id, { type: "flag_updated", flag: updated });
    return updated;
  }

  // ---------------- ingest → classify → flag ----------------

  /** Queues a new message for classification. Returns false if its server isn't being watched. */
  ingest(incoming: IncomingMessage): boolean {
    const msg: Queued = { ...incoming, images: this.d.config.LIVE_WATCH_IMAGES ? (incoming.images ?? []) : [] };
    if (!this.active.has(msg.guildId) || (!msg.content.trim() && msg.images.length === 0)) return false;
    const buf = this.buffers.get(msg.guildId) ?? [];
    buf.push(msg);
    this.buffers.set(msg.guildId, buf);
    if (buf.length >= this.d.config.LIVE_WATCH_BATCH_SIZE) {
      void this.flush(msg.guildId);
    } else if (!this.timers.has(msg.guildId)) {
      const t = setTimeout(() => void this.flush(msg.guildId), this.d.config.LIVE_WATCH_BATCH_MS);
      t.unref();
      this.timers.set(msg.guildId, t);
    }
    return true;
  }

  /** Classifies everything queued (tests call this directly instead of waiting for the timer). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.buffers.keys()].map((g) => this.flush(g)));
  }

  private window(serverId: string): HourWindow {
    const now = Date.now();
    let w = this.windows.get(serverId);
    if (!w || now - w.start > HOUR_MS) {
      w = { start: now, classified: 0, deleted: 0, images: 0, warnedClassify: false, warnedDelete: false, warnedImages: false };
      this.windows.set(serverId, w);
    }
    return w;
  }

  private async flush(guildId: string): Promise<void> {
    const timer = this.timers.get(guildId);
    if (timer) clearTimeout(timer);
    this.timers.delete(guildId);
    const queued = this.buffers.get(guildId) ?? [];
    this.buffers.delete(guildId);
    const entry = this.active.get(guildId);
    if (!entry || queued.length === 0 || !this.d.anthropic) return;

    const win = this.window(entry.server.id);
    const room = Math.max(0, this.d.config.LIVE_WATCH_MAX_MESSAGES_PER_HOUR - win.classified);
    const batch = queued.slice(0, room);
    if (batch.length < queued.length && !win.warnedClassify) {
      win.warnedClassify = true;
      this.emit(entry.server.id, {
        type: "notice", level: "warn",
        message: `This server hit its limit of ${this.d.config.LIVE_WATCH_MAX_MESSAGES_PER_HOUR} checked messages this hour. New messages aren't being checked until the hour is up.`,
      });
    }
    if (batch.length === 0) return;
    win.classified += batch.length;

    // Fetch images once per message (shared by every watch on this server), within the hourly cap.
    const inAnyScope = (m: Queued) => entry.watches.some((w) => this.inScope(w, m));
    await this.fetchImages(entry, win, batch.filter(inAnyScope));
    // An image-only message whose images couldn't be fetched has nothing left to check.
    const checkable = batch.filter((m) => m.content.trim() || m.fetched?.length);

    for (const watch of entry.watches) {
      const inScope = checkable.filter((m) => this.inScope(watch, m));
      if (inScope.length) await this.classifyForWatch(entry, watch, inScope);
    }
  }

  private inScope(watch: LiveWatch, m: IncomingMessage): boolean {
    return watch.channelIds.length === 0 || watch.channelIds.includes(m.channelId) || (m.parentChannelId ? watch.channelIds.includes(m.parentChannelId) : false);
  }

  private async fetchImages(entry: ActiveServer, win: HourWindow, msgs: Queued[]): Promise<void> {
    const jobs: Array<{ msg: Queued; url: string }> = [];
    for (const msg of msgs) {
      for (const img of msg.images) {
        if (win.images >= this.d.config.LIVE_WATCH_MAX_IMAGES_PER_HOUR) {
          if (!win.warnedImages) {
            win.warnedImages = true;
            this.emit(entry.server.id, {
              type: "notice", level: "warn",
              message: `This server hit its limit of ${this.d.config.LIVE_WATCH_MAX_IMAGES_PER_HOUR} checked images this hour. Message text is still checked; images aren't until the hour is up.`,
            });
          }
          break;
        }
        if (img.size > MAX_IMAGE_BYTES) continue;
        win.images++;
        jobs.push({ msg, url: img.url });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const image = await this.fetchImage(job.url);
        if (image) (job.msg.fetched ??= []).push(image);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, jobs.length) }, worker));
  }

  /** Splits messages into classifier calls: at most BATCH_SIZE messages and a bounded number of image bytes each. */
  private chunks(msgs: Queued[]): number[][] {
    const out: number[][] = [];
    let cur: number[] = [];
    let images = 0;
    let bytes = 0;
    msgs.forEach((m, i) => {
      const n = m.fetched?.length ?? 0;
      const b = (m.fetched ?? []).reduce((s, img) => s + img.data.length, 0);
      if (cur.length && (cur.length >= this.d.config.LIVE_WATCH_BATCH_SIZE || images + n > MAX_IMAGES_PER_CALL || bytes + b > MAX_IMAGE_BYTES_PER_CALL)) {
        out.push(cur);
        cur = [];
        images = 0;
        bytes = 0;
      }
      cur.push(i);
      images += n;
      bytes += b;
    });
    if (cur.length) out.push(cur);
    return out;
  }

  private async classifyForWatch(entry: ActiveServer, watch: LiveWatch, msgs: Queued[]): Promise<void> {
    const candidates = msgs.map((m) => ({ authorName: m.authorName, channelName: m.channelName, content: m.content, images: m.fetched }));
    const matched = new Map<number, { severity: LiveFlag["severity"]; reason: string }>();
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (const idx of this.chunks(msgs)) {
      const ok = await classifyBatch({ anthropic: this.d.anthropic!, model: this.d.config.WHISPCORD_CLASSIFIER_MODEL }, watch.criteria, idx, candidates, matched, usage);
      if (!ok) this.d.log?.warn(`Live watch ${watch.id}: a batch of ${idx.length} message(s) couldn't be classified`);
    }
    if (usage.inputTokens + usage.outputTokens > 0) {
      await this.d.store.recordUsage(watch.createdBy, { tokens: usage.inputTokens + usage.outputTokens }).catch(() => undefined);
    }

    for (const [i, m] of matched) {
      const msg = msgs[i]!;
      const flag = await this.d.store.insertFlag({
        watchId: watch.id, serverId: entry.server.id, messageId: msg.messageId, channelId: msg.channelId, channelName: msg.channelName,
        authorId: msg.authorId, authorName: msg.authorName, postedAt: msg.createdAt, severity: m.severity, reason: m.reason,
        excerpt: excerptFor(msg), jumpUrl: msg.jumpUrl, action: "none", actionError: null,
      });
      if (!flag) continue; // already flagged by this watch
      this.emit(entry.server.id, { type: "flag", flag });
      if (watch.autoDelete && flag.severity === "high") await this.autoDelete(entry, watch, flag);
    }
  }

  private async autoDelete(entry: ActiveServer, watch: LiveWatch, flag: LiveFlag): Promise<void> {
    const fail = async (reason: string) => {
      const updated = await this.d.store.updateFlag(flag.id, { action: "auto_delete_failed", actionError: reason });
      if (updated) this.emit(entry.server.id, { type: "flag_updated", flag: updated });
    };
    // Deletions may have been switched off since the watch started.
    if (!entry.server.enabledTiers.includes("destructive")) return fail("Deletions is switched off in Settings, so the message was only flagged.");

    const win = this.window(entry.server.id);
    if (win.deleted >= this.d.config.LIVE_WATCH_MAX_AUTO_DELETES_PER_HOUR) {
      if (!win.warnedDelete) {
        win.warnedDelete = true;
        this.emit(entry.server.id, {
          type: "notice", level: "warn",
          message: `Auto-delete paused: this server hit its limit of ${this.d.config.LIVE_WATCH_MAX_AUTO_DELETES_PER_HOUR} automatic deletions this hour. Matches are still flagged.`,
        });
      }
      return fail("Hourly auto-delete limit reached, so the message was only flagged.");
    }

    // Live permission check of the person who approved the watch (rules 3 and 4).
    if (!(await this.creatorMayDelete(entry.server.guildId, watch))) {
      return fail("The person who started this watch no longer has Manage Server and Manage Messages, so the message was only flagged.");
    }

    win.deleted++;
    let res: ToolCallResult;
    try {
      res = await this.d.mcp.callTool("delete_message", { channelId: flag.channelId, messageId: flag.messageId });
    } catch (err) {
      res = { text: (err as Error).message, isError: true };
    }
    if (res.isError) return fail(res.text.slice(0, 300));
    const updated = await this.d.store.updateFlag(flag.id, { action: "auto_deleted", actionError: null });
    if (updated) this.emit(entry.server.id, { type: "flag_updated", flag: updated });
  }

  private async creatorMayDelete(guildId: string, watch: LiveWatch): Promise<boolean> {
    const cached = this.permCache.get(watch.id);
    if (cached && Date.now() - cached.at < PERMISSION_CACHE_MS) return cached.ok;
    let ok = false;
    try {
      const p = await this.d.internal.memberPermissions(guildId, watch.createdByDiscordId);
      ok = p.botInGuild && p.canManageServer && canManageMessages(p);
    } catch {
      ok = false;
    }
    this.permCache.set(watch.id, { ok, at: Date.now() });
    return ok;
  }
}
