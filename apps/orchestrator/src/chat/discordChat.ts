import type { RunEvent, ValidatedPlan } from "@whispcord/shared";
import { z } from "zod";
import type { Config } from "../config.js";
import type { WhispcordInternal } from "../mcp/client.js";
import type { RunEvents } from "../runs/events.js";
import { HttpError, type RunService } from "../runs/service.js";
import type { Store } from "../store/types.js";

/**
 * Discord chat: server managers talk to Whispcord by @mentioning the bot.
 *
 * discord-mcp forwards a message only when it mentions the bot directly and its author has
 * Manage Server. That one message is the administrator's prompt, exactly like the web prompt box.
 * Everything else is the ordinary run flow: the live permission check, the guild lock, tiers and
 * limits all apply, and nothing changes until the requester presses Approve (plus types DELETE
 * for deletions). Only the person who asked can approve, cancel or answer a question.
 */

const Snowflake = z.string().regex(/^\d{17,20}$/);

export const MentionSchema = z.object({
  type: z.literal("mention"),
  guildId: Snowflake,
  channelId: Snowflake,
  messageId: Snowflake,
  authorId: Snowflake,
  content: z.string().max(4000),
  replyToMessageId: Snowflake.nullable().optional(),
});
export type Mention = z.infer<typeof MentionSchema>;

export const InteractionSchema = z.object({
  type: z.literal("interaction"),
  action: z.enum(["approve", "cancel"]),
  runId: z.string().uuid(),
  guildId: Snowflake,
  channelId: Snowflake,
  messageId: Snowflake.nullable().optional(),
  userId: Snowflake,
  confirmation: z.string().max(100).optional(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

/** Where updates about a run are posted: replies to the administrator's message. */
interface Thread {
  guildId: string;
  channelId: string;
  replyTo: string | null;
}

/** Discord allows 2000 characters per message. */
const MAX_MESSAGE = 1950;
/** Stop listening for a run's events after this long (planning or execution that never ends). */
const FOLLOW_TIMEOUT_MS = 60 * 60 * 1000;
/** Bot question messages remembered so a reply answers the right run. */
const MAX_TRACKED_QUESTIONS = 500;

export interface DiscordChatDeps {
  store: Store;
  runs: RunService;
  events: RunEvents;
  internal: WhispcordInternal;
  config: Config;
  log?: { warn: (msg: string) => void };
}

export class DiscordChatService {
  /** Bot question message ID → run ID, so replying to a question answers that run. */
  private questions = new Map<string, string>();

  constructor(private readonly d: DiscordChatDeps) {}

  private serverUrl(guildId: string) {
    return `${this.d.config.WEB_ORIGIN}/servers/${guildId}`;
  }

  private async post(thread: Thread, content: string, buttons?: Array<{ action: "approve" | "confirm" | "cancel"; runId: string }>) {
    try {
      return await this.d.internal.postChatMessage({
        guildId: thread.guildId,
        channelId: thread.channelId,
        content: clip(content),
        replyToMessageId: thread.replyTo,
        buttons,
      });
    } catch (err) {
      this.d.log?.warn(`Discord chat: couldn't post in ${thread.guildId}/${thread.channelId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** A forwarded @mention. Never throws: failures become a reply or a log line. */
  async handleMention(m: Mention): Promise<void> {
    const thread: Thread = { guildId: m.guildId, channelId: m.channelId, replyTo: m.messageId };
    try {
      await this.mention(m, thread);
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : "Something went wrong on my side. Try again, or use the web app.";
      if (!(err instanceof HttpError)) this.d.log?.warn(`Discord chat failed: ${(err as Error).message}`);
      await this.post(thread, msg);
    }
  }

  private async mention(m: Mention, thread: Thread) {
    const { store, runs } = this.d;
    const server = await store.getServerByGuildId(m.guildId);
    if (!server || server.status !== "connected") {
      await this.post(thread, `This server isn't connected to Whispcord yet. Connect it at ${this.d.config.WEB_ORIGIN}/servers, then mention me again.`);
      return;
    }
    const profile = await store.getProfileByDiscordUserId(m.authorId);
    if (!profile) {
      await this.post(thread, `I don't know you yet. Sign in once at ${this.d.config.WEB_ORIGIN} with Discord, then mention me again.`);
      return;
    }
    const prompt = m.content.trim();
    if (!prompt) {
      await this.post(thread, "Tell me what to change after the mention, e.g. `@Whispcord add a #clips channel under Media and let only @Mods post in it`. I'll show you a plan before I touch anything.");
      return;
    }

    // Replying to one of my questions answers it (only the person who asked).
    const questionRunId = m.replyToMessageId ? this.questions.get(m.replyToMessageId) : undefined;
    if (questionRunId) {
      const run = await store.getRun(questionRunId);
      if (run && run.serverId === server.id && run.status === "needs_input") {
        if (run.profileId !== profile.id) {
          await this.post(thread, "Only the person who started this request can answer my question.");
          return;
        }
        this.questions.delete(m.replyToMessageId!);
        const stop = this.follow(run.id, thread, "plan");
        try {
          await runs.answer(run, server, profile, prompt);
        } catch (err) {
          stop();
          throw err;
        }
        return;
      }
    }

    // A new request. startRun re-checks Manage Server live and applies the rate limits.
    await runs.startRun(server, profile, prompt, "prompt", null, (run) => this.follow(run.id, thread, "plan"));
  }

  /**
   * Posts what happens next in a run, then stops listening. "plan": the plan, a question, a
   * report or a failure. "execute": the result once every approved step ran (or one failed).
   */
  private follow(runId: string, thread: Thread, phase: "plan" | "execute"): () => void {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
    };
    const timer = setTimeout(stop, FOLLOW_TIMEOUT_MS);
    timer.unref?.();
    const unsubscribe = this.d.events.subscribe(runId, (e: RunEvent) => {
      void this.onEvent(e, thread, phase, stop).catch((err: Error) => this.d.log?.warn(`Discord chat: ${err.message}`));
    });
    return stop;
  }

  private async onEvent(e: RunEvent, thread: Thread, phase: "plan" | "execute", stop: () => void) {
    if (phase === "plan") {
      if (e.type === "plan") {
        stop();
        const destructive = e.plan.requiresConfirmation;
        await this.post(thread, formatPlan(e.plan, this.serverUrl(thread.guildId)), [
          { action: destructive ? "confirm" : "approve", runId: e.runId },
          { action: "cancel", runId: e.runId },
        ]);
      } else if (e.type === "question") {
        stop();
        const sent = await this.post(thread, `${e.question}\n\n-# Reply to this message (keep the @ on) to answer.`);
        if (sent) this.rememberQuestion(sent.messageId, e.runId);
      } else if (e.type === "report") {
        stop();
        await this.post(thread, `${e.summary}\n\n-# Details: ${this.serverUrl(thread.guildId)}`);
      } else if (e.type === "status" && (e.status === "failed" || e.status === "cancelled")) {
        stop();
        if (e.status === "failed") await this.post(thread, `I couldn't plan that: ${e.message ?? "unknown error"}`);
      }
      return;
    }
    if (e.type !== "status") return;
    if (e.status === "done") {
      stop();
      const actions = await this.d.store.listActions(e.runId);
      const ok = actions.filter((a) => a.status === "succeeded").length;
      await this.post(thread, `Done. ${ok} step${ok === 1 ? "" : "s"} ran. You can undo this at ${this.serverUrl(thread.guildId)}`);
    } else if (e.status === "failed") {
      stop();
      await this.post(thread, `That run stopped: ${e.message ?? "unknown error"}\nRetry, fix or undo it at ${this.serverUrl(thread.guildId)}`);
    }
  }

  private rememberQuestion(messageId: string, runId: string) {
    if (this.questions.size >= MAX_TRACKED_QUESTIONS) {
      const oldest = this.questions.keys().next().value;
      if (oldest) this.questions.delete(oldest);
    }
    this.questions.set(messageId, runId);
  }

  /**
   * An Approve / Cancel button (or the DELETE confirmation). Returns the private reply shown to
   * whoever clicked, and whether the buttons should be removed.
   */
  async handleInteraction(i: Interaction): Promise<{ text: string; done: boolean }> {
    const { store, runs, internal } = this.d;
    const gone = { text: "I can't find that plan anymore.", done: true };
    const run = await store.getRun(i.runId);
    if (!run) return gone;
    const server = await store.getServerById(run.serverId);
    // A button only ever acts on a run of the server it was clicked in.
    if (!server || server.guildId !== i.guildId) return gone;
    const profile = await store.getProfileByDiscordUserId(i.userId);
    if (!profile || profile.id !== run.profileId) {
      return { text: "Only the person who asked for this plan can approve or cancel it.", done: false };
    }
    const perms = await internal.memberPermissions(server.guildId, i.userId);
    if (!perms.canManageServer) return { text: "You need Manage Server on this server to use Whispcord.", done: false };

    try {
      if (i.action === "cancel") {
        await runs.cancel(run);
        return { text: "Cancelled. Nothing was changed.", done: true };
      }
      if (run.status !== "awaiting_approval" || !run.plan) return { text: "This plan isn't waiting for approval anymore.", done: true };
      const thread: Thread = { guildId: server.guildId, channelId: i.channelId, replyTo: i.messageId ?? null };
      const stop = this.follow(run.id, thread, "execute");
      try {
        await runs.approve(run, server, profile, run.plan.steps.map((s) => s.id), i.confirmation);
      } catch (err) {
        stop();
        throw err;
      }
      return { text: "Approved. I'm on it.", done: true };
    } catch (err) {
      if (err instanceof HttpError) return { text: err.message, done: false };
      throw err;
    }
  }
}

function clip(text: string) {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

/** The plan as a Discord message. Pings are suppressed by post_chat_message. */
export function formatPlan(plan: ValidatedPlan, url: string): string {
  const head = `**Here's my plan:** ${plan.summary}`;
  const footer = [
    ...plan.warnings.map((w) => `> ⚠️ ${w}`),
    plan.requiresConfirmation
      ? `This plan deletes things. Press **Approve** and type ${plan.confirmationPhrase ?? "DELETE"} to run it.`
      : "Press **Approve** to run every step.",
    `-# To run only some steps, open ${url}`,
  ].join("\n");
  const lines = plan.steps.map((s, i) => `${i + 1}. ${s.destructive ? "🗑️ " : ""}${s.reason || s.tool} \`${s.tool}\``);
  const more = (n: number) => `…and ${n} more step(s). See them all at ${url}`;
  // Room for the head, footer, blank lines and a possible "…and N more" line.
  const budget = MAX_MESSAGE - head.length - footer.length - more(lines.length).length - 8;
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    shown.push(line);
    used += line.length + 1;
  }
  if (shown.length < lines.length) shown.push(more(lines.length - shown.length));
  return [head, "", ...shown, "", footer].join("\n");
}
