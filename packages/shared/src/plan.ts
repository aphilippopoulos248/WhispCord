import { z } from "zod";

export const RISK = ["low", "medium", "high"] as const;

/** Placeholder syntax for referencing an earlier step's created object: {{s1.id}} */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][\w-]*)\.id\s*\}\}/g;

export const PlanStepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][\w-]{0,31}$/, "step id must be short and start with a letter, e.g. s1"),
  tool: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  reason: z.string().max(500).default(""),
  risk: z.enum(RISK).default("low"),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  summary: z.string().max(1000),
  steps: z.array(PlanStepSchema).max(100),
});
export type Plan = z.infer<typeof PlanSchema>;

export const RUN_STATUSES = [
  "planning",
  "needs_input",
  "awaiting_approval",
  "running",
  "done",
  "failed",
  "undone",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ACTION_STATUSES = ["pending", "running", "succeeded", "failed", "skipped"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Server-side validation output shown in the plan preview. */
export interface ValidatedStep extends PlanStep {
  tier: string;
  group: string;
  destructive: boolean;
  undoable: boolean;
  dependsOn: string[];
}

export interface ValidatedPlan {
  summary: string;
  steps: ValidatedStep[];
  /** Typed confirmation required before destructive steps can run. */
  requiresConfirmation: boolean;
  confirmationPhrase: string | null;
  warnings: string[];
}

/** One message the classifier matched against the administrator's criteria. */
export interface MessageFinding {
  /** Short handle Claude uses to refer to it (f1, f2, ...). */
  ref: string;
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  severity: "low" | "medium" | "high";
  reason: string;
  /** Start of the message text, for the administrator only (never sent to the planner). */
  excerpt: string;
  jumpUrl: string;
}

export interface MessageSearchStats {
  scanned: number;
  classified: number;
  channels: number;
  skippedChannels: Array<{ id: string; name?: string; reason: string }>;
  unclassifiedBatches: number;
  truncated: boolean;
  contentAvailable: boolean;
}

/** Events streamed to the browser over SSE. */
export type RunEvent =
  | { type: "status"; runId: string; status: RunStatus; message?: string }
  | { type: "plan"; runId: string; plan: ValidatedPlan }
  | { type: "question"; runId: string; question: string }
  | { type: "report"; runId: string; summary: string; findings: MessageFinding[] }
  | { type: "step"; runId: string; stepId: string; status: ActionStatus; result?: string; error?: string; durationMs?: number }
  | { type: "log"; runId: string; message: string }
  | { type: "done"; runId: string; status: RunStatus };

export function findPlaceholders(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
}

export function substitutePlaceholders(
  args: Record<string, string | number | boolean>,
  createdIds: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    const s = String(v);
    out[k] = s.replace(PLACEHOLDER_RE, (_m, stepId: string) => {
      const id = createdIds[stepId];
      if (!id) throw new Error(`Step ${stepId} has not produced an id yet`);
      return id;
    });
  }
  return out;
}
