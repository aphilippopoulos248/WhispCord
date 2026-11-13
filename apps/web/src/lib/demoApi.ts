"use client";

import type { MessageFinding, MessageSearchStats, RunEvent, RunStatus, ValidatedPlan, ValidatedStep } from "@whispcord/shared";
import { demoRuns, demoSnapshot } from "./demoData";
import { demoWatchApi } from "./demoWatch";

/**
 * Simulated orchestrator for demo mode. Keeps state in memory in the browser tab and plays back
 * planning and execution with short delays so the live UI can be seen.
 */

interface DemoRun {
  id: string;
  kind: "prompt" | "undo" | "fix";
  prompt: string;
  status: RunStatus;
  plan: ValidatedPlan | null;
  pendingQuestion: { question: string } | null;
  approvedStepIds: string[] | null;
  error: string | null;
  report?: string | null;
  messageSearch?: { findings: MessageFinding[]; searches: Array<MessageSearchStats & { criteria: string }> } | null;
  guildId: string;
  parentRunId: string | null;
}

interface DemoAction {
  stepId: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  resultText: string | null;
  error: string | null;
  inverseAction: unknown;
  createdId?: string;
}

const runs = new Map<string, DemoRun>();
const actions = new Map<string, Record<string, DemoAction>>();
const listeners = new Map<string, Set<(e: RunEvent) => void>>();
const snapshots = new Map<string, ReturnType<typeof demoSnapshot>>();
let counter = 0;

// Seed the history entry so it opens.
for (const r of demoRuns) {
  runs.set(r.id, {
    id: r.id, kind: "prompt", prompt: r.prompt, status: "done", guildId: "", parentRunId: null,
    pendingQuestion: null, error: null, approvedStepIds: ["s1", "s2"],
    plan: {
      summary: "Create a read-only #rules channel at the top of the server.",
      steps: [
        step("s1", "create_text_channel", { name: "rules", position: "0" }, "channel", "Rules belong at the very top", true),
        step("s2", "upsert_role_channel_permissions", { channelId: "{{s1.id}}", roleId: "@everyone", denyRaw: "2048" }, "permission", "Everyone can read but not send", true, ["s1"]),
      ],
      requiresConfirmation: false, confirmationPhrase: null, warnings: [],
    },
  });
  actions.set(r.id, {
    s1: { stepId: "s1", status: "succeeded", resultText: "Created text channel: rules", error: null, inverseAction: {} },
    s2: { stepId: "s2", status: "succeeded", resultText: "Updated permissions", error: null, inverseAction: {} },
  });
}

function step(
  id: string, tool: string, args: Record<string, string>, group: string, reason: string,
  undoable = true, dependsOn: string[] = [], destructive = false,
): ValidatedStep {
  return {
    id, tool, args, reason, risk: destructive ? "high" : "low",
    tier: destructive ? "destructive" : "build", group, destructive, undoable, dependsOn,
  };
}

function emit(e: RunEvent) {
  listeners.get(e.runId)?.forEach((l) => l(e));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setStatus(run: DemoRun, status: RunStatus) {
  run.status = status;
  emit({ type: "status", runId: run.id, status });
  if (status !== "planning" && status !== "running") emit({ type: "done", runId: run.id, status });
}

function snapshotFor(guildId: string) {
  if (!snapshots.has(guildId)) snapshots.set(guildId, demoSnapshot(guildId));
  return snapshots.get(guildId)!;
}

function samplePlan(prompt: string): ValidatedPlan {
  const p = prompt.toLowerCase();
  const steps: ValidatedStep[] = [
    step("s1", "create_category", { name: "Gaming" }, "category", "A home for the new channels"),
    step("s2", "create_text_channel", { name: "general", categoryId: "{{s1.id}}" }, "channel", "Main gaming chat", true, ["s1"]),
    step("s3", "create_text_channel", { name: "clips", categoryId: "{{s1.id}}" }, "channel", "Share highlights", true, ["s1"]),
    step("s4", "create_text_channel", { name: "lfg", categoryId: "{{s1.id}}" }, "channel", "Looking-for-group posts", true, ["s1"]),
    step("s5", "create_voice_channel", { name: "Squad", categoryId: "{{s1.id}}" }, "channel", "Voice for playing together", true, ["s1"]),
    step("s6", "create_role", { name: "Gaming Mod", color: "3985297" }, "role", "Moderators for the gaming area"),
    step("s7", "upsert_role_channel_permissions", { channelId: "{{s2.id}}", roleId: "{{s6.id}}", allowRaw: "8192" }, "permission", "Let Gaming Mods manage messages in #general", true, ["s2", "s6"]),
  ];
  if (p.includes("delete") || p.includes("remove")) {
    steps.push(step("s8", "delete_channel", { channelId: "900000000000000007" }, "channel", "You asked to remove #memes", false, [], true));
  }
  const destructive = steps.some((s) => s.destructive);
  return {
    summary: "Create a Gaming category with general, clips and LFG text channels, a Squad voice channel, and a Gaming Mod role that can manage messages in #general.",
    steps,
    requiresConfirmation: destructive,
    confirmationPhrase: destructive ? "DELETE" : null,
    warnings: destructive ? ["Deleted channels, roles and messages cannot be restored by Undo."] : [],
  };
}

async function plan(run: DemoRun) {
  setStatus(run, "planning");
  for (const msg of ["Reading the server structure", "Looking up: list_channels", "Looking up: list_roles"]) {
    await wait(700);
    emit({ type: "log", runId: run.id, message: msg });
  }
  await wait(900);
  // Prompts about messages show message search (sample data).
  if (/message/i.test(run.prompt) && run.kind === "prompt") {
    emit({ type: "log", runId: run.id, message: "Searching messages" });
    await wait(1200);
    const ch = demoSnapshot(run.guildId);
    const general = ch.channels.find((c) => c.name === "general")!;
    const memes = ch.channels.find((c) => c.name === "memes")!;
    const base = `https://discord.com/channels/${run.guildId}`;
    const ago = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    run.messageSearch = {
      findings: [
        { ref: "f1", messageId: "970000000000000001", channelId: general.id, channelName: "general", authorId: "400000000000000101", authorName: "edgelord42", createdAt: ago(5), severity: "high", reason: "Slur targeting a group of people", excerpt: "(sample message hidden in demo mode)", jumpUrl: `${base}/${general.id}/970000000000000001` },
        { ref: "f2", messageId: "970000000000000002", channelId: memes.id, channelName: "memes", authorId: "400000000000000102", authorName: "anon_raider", createdAt: ago(30), severity: "medium", reason: "Insults another member repeatedly", excerpt: "(sample message hidden in demo mode)", jumpUrl: `${base}/${memes.id}/970000000000000002` },
        { ref: "f3", messageId: "970000000000000003", channelId: general.id, channelName: "general", authorId: "400000000000000103", authorName: "casualgamer", createdAt: ago(70), severity: "low", reason: "Mildly demeaning joke", excerpt: "(sample message hidden in demo mode)", jumpUrl: `${base}/${general.id}/970000000000000003` },
      ],
      searches: [{ criteria: run.prompt, scanned: 412, classified: 398, channels: 4, skippedChannels: [], unclassifiedBatches: 0, truncated: false, contentAvailable: true }],
    };
    run.report = "I checked 412 recent messages across 4 channels and found 3 that look hateful or harassing: one high-severity slur from edgelord42 in #general, repeated insults from anon_raider in #memes, and a mildly demeaning joke. Nothing was changed; ask me if you want them deleted or the authors timed out.";
    emit({ type: "report", runId: run.id, summary: run.report, findings: run.messageSearch.findings });
    setStatus(run, "done");
    return;
  }
  // Very short prompts get a clarifying question, to show that flow.
  if (run.prompt.trim().split(/\s+/).length < 4 && !run.pendingQuestion && run.kind === "prompt") {
    run.pendingQuestion = { question: "Do you want this as a new category, or added to the existing Community category?" };
    emit({ type: "question", runId: run.id, question: run.pendingQuestion.question });
    setStatus(run, "needs_input");
    return;
  }
  run.plan = run.plan ?? samplePlan(run.prompt);
  emit({ type: "plan", runId: run.id, plan: run.plan });
  setStatus(run, "awaiting_approval");
}

async function execute(run: DemoRun) {
  setStatus(run, "running");
  const acts = actions.get(run.id) ?? {};
  actions.set(run.id, acts);
  const snap = snapshotFor(run.guildId);
  const created: Record<string, string> = {};
  for (const s of run.plan!.steps) {
    if (!run.approvedStepIds!.includes(s.id)) {
      acts[s.id] = { stepId: s.id, status: "skipped", resultText: null, error: null, inverseAction: null };
      emit({ type: "step", runId: run.id, stepId: s.id, status: "skipped" });
      continue;
    }
    acts[s.id] = { stepId: s.id, status: "running", resultText: null, error: null, inverseAction: null };
    emit({ type: "step", runId: run.id, stepId: s.id, status: "running" });
    await wait(550);
    const newId = `95${String(Date.now()).slice(-10)}${String(++counter).padStart(6, "0")}`;
    const arg = (k: string) => (s.args[k] === undefined ? "" : String(s.args[k]));
    const resolve = (v: string) => v.replace(/\{\{(\w+)\.id\}\}/, (_m, k: string) => created[k] ?? "");
    if (s.tool === "create_category") snap.channels.push({ id: newId, name: arg("name"), type: "CATEGORY", parentId: null, position: 9 });
    if (s.tool === "create_text_channel" || s.tool === "create_voice_channel") {
      snap.channels.push({ id: newId, name: arg("name"), type: s.tool === "create_voice_channel" ? "VOICE" : "TEXT", parentId: resolve(arg("categoryId")) || null, position: Object.keys(created).length });
    }
    if (s.tool === "create_role") {
      snap.roles.push({ id: newId, name: arg("name"), position: 2, color: Number(s.args.color ?? 0), permissions: "0", managed: false, isEveryone: false, hoisted: false });
    }
    if (s.tool === "delete_channel") snap.channels = snap.channels.filter((c) => c.id !== s.args.channelId);
    if (s.tool === "delete_category") snap.channels = snap.channels.filter((c) => c.id !== s.args.categoryId && c.parentId !== s.args.categoryId);
    if (s.tool === "delete_role") snap.roles = snap.roles.filter((r) => r.id !== s.args.roleId);
    created[s.id] = newId;
    const result = `${s.tool.replaceAll("_", " ")} ✓ (ID: ${newId})`;
    acts[s.id] = { stepId: s.id, status: "succeeded", resultText: result, error: null, inverseAction: s.undoable ? {} : null, createdId: newId };
    emit({ type: "step", runId: run.id, stepId: s.id, status: "succeeded", result, durationMs: 550 });
  }
  if (run.kind === "undo" && run.parentRunId) {
    const parent = runs.get(run.parentRunId);
    if (parent) parent.status = "undone";
  }
  setStatus(run, "done");
}

function createRun(guildId: string, prompt: string, kind: DemoRun["kind"] = "prompt", parentRunId: string | null = null): DemoRun {
  const run: DemoRun = {
    id: `demo-${Date.now()}-${++counter}`, kind, prompt, status: "planning", plan: null, pendingQuestion: null,
    approvedStepIds: null, error: null, guildId, parentRunId,
  };
  runs.set(run.id, run);
  return run;
}

export async function demoApi<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  await wait(150);
  const body = (init.body ?? {}) as Record<string, unknown>;
  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/servers\/(\d+)\/snapshot$/))) return structuredClone(snapshotFor(m[1]!)) as T;
  if ((m = path.match(/^\/servers\/(\d+)\/bot-status$/))) {
    return { botRoleOk: m[1] !== "223456789012345678", status: { inGuild: true } } as T;
  }
  if ((m = path.match(/^\/servers\/(\d+)\/settings$/))) {
    const tiers = (body.enabledTiers as string[]) ?? [];
    return { enabledTiers: ["read", ...tiers], needsPermissionUpgrade: tiers.includes("moderate") } as T;
  }
  if (path.match(/^\/servers\/\d+\/disconnect$/)) throw new Error("Disconnecting is disabled in demo mode.");
  if (path.match(/^\/servers\/\d+\/permissions-upgrade$/)) throw new Error("Changing bot permissions is disabled in demo mode.");
  if (path === "/me") throw new Error("Account deletion is disabled in demo mode.");
  if ((m = path.match(/^\/servers\/(\d+)\/runs$/))) {
    const run = createRun(m[1]!, String(body.prompt ?? ""));
    void plan(run);
    return { runId: run.id } as T;
  }
  if (path === "/connect/start") throw new Error("Connecting a real server is disabled in demo mode.");
  const watch = demoWatchApi(path);
  if (watch !== undefined) return watch as T;

  if ((m = path.match(/^\/runs\/([\w-]+)(?:\/(\w+))?$/))) {
    const run = runs.get(m[1]!);
    if (!run) throw new Error("Run not found.");
    const action = m[2];
    if (!action) {
      const { guildId: _g, parentRunId: _p, ...dto } = run;
      return { run: dto, actions: Object.values(actions.get(run.id) ?? {}) } as T;
    }
    switch (action) {
      case "answer":
        run.pendingQuestion = null;
        run.prompt += `\n\n(Answer: ${String(body.answer)})`;
        run.kind = "fix"; // skip the question next time
        void plan(run).then(() => { run.kind = "prompt"; });
        return { ok: true } as T;
      case "approve": {
        const stepIds = (body.stepIds as string[]) ?? [];
        if (run.plan?.requiresConfirmation && run.plan.steps.some((s) => s.destructive && stepIds.includes(s.id)) && body.confirmation !== "DELETE") {
          throw new Error("Type DELETE to confirm the deletions in this plan.");
        }
        run.approvedStepIds = stepIds;
        void execute(run);
        return { ok: true } as T;
      }
      case "cancel":
        setStatus(run, "cancelled");
        return { ok: true } as T;
      case "undo": {
        const done = Object.values(actions.get(run.id) ?? {}).filter((a) => a.status === "succeeded" && a.inverseAction);
        const original = run.plan?.steps ?? [];
        const undo = createRun(run.guildId, `Undo: ${run.prompt}`, "undo", run.id);
        undo.plan = {
          summary: `Undo of: ${run.prompt.slice(0, 120)}`,
          steps: done.reverse().map((a, i) => {
            const s = original.find((x) => x.id === a.stepId)!;
            const [tool, arg] = s.tool === "create_category" ? ["delete_category", "categoryId"]
              : s.tool === "create_role" ? ["delete_role", "roleId"]
              : s.tool.startsWith("create_") ? ["delete_channel", "channelId"]
              : ["restore_previous_state", "of"];
            return step(`u${i + 1}`, tool, { [arg]: a.createdId ?? s.id }, s.group, `Reverses step ${s.id} (${s.tool}: ${s.args.name ?? ""})`, false);
          }),
          requiresConfirmation: false, confirmationPhrase: null,
          warnings: ["Undo deletes only what this run created. Messages posted in those channels since then will be lost."],
        };
        undo.status = "awaiting_approval";
        return { runId: undo.id } as T;
      }
      case "retry":
      case "fix":
        throw new Error("Nothing failed in this demo run.");
    }
  }
  throw new Error(`Demo mode has no handler for ${path}`);
}

export function demoSubscribe(runId: string, onEvent: (e: RunEvent) => void): () => void {
  const set = listeners.get(runId) ?? new Set();
  set.add(onEvent);
  listeners.set(runId, set);
  const run = runs.get(runId);
  if (run) queueMicrotask(() => onEvent({ type: "status", runId, status: run.status }));
  return () => set.delete(onEvent);
}
