import {
  PlanSchema,
  findPlaceholders,
  toolSpec,
  type Plan,
  type ValidatedPlan,
  type ValidatedStep,
} from "@whispcord/shared";
import { GatewayError, type GatewayLimits, type GuildGateway } from "../gateway/gateway.js";

export class PlanValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Plan is invalid:\n- ${problems.join("\n- ")}`);
    this.name = "PlanValidationError";
  }
}

const UNDOABLE_EDITS = new Set([
  "edit_category", "edit_text_channel", "edit_voice_channel", "move_channel", "edit_role", "edit_emoji",
  "upsert_role_channel_permissions", "upsert_member_channel_permissions", "delete_channel_permission_overwrite",
  "assign_role", "remove_role",
]);

/**
 * Server-side plan validation. Claude's plan is a proposal; nothing in it is trusted until it
 * passes here (and every call is checked again by the gateway at execution time).
 */
export async function validatePlan(
  raw: unknown,
  gateway: GuildGateway,
  limits: GatewayLimits,
  opts: { confirmationPhrase: string },
): Promise<ValidatedPlan> {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanValidationError(parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`));
  }
  const plan: Plan = parsed.data;
  const problems: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, { creates: boolean }>();
  const steps: ValidatedStep[] = [];
  let creations = 0;
  let deletions = 0;

  for (const step of plan.steps) {
    const where = `step ${step.id} (${step.tool})`;
    if (seen.has(step.id)) {
      problems.push(`${where}: duplicate step id`);
      continue;
    }
    const spec = toolSpec(step.tool);
    const dependsOn = new Set<string>();
    for (const v of Object.values(step.args)) {
      for (const ref of findPlaceholders(v)) {
        const target = seen.get(ref);
        if (!target) problems.push(`${where}: placeholder {{${ref}.id}} must reference an earlier step`);
        else if (!target.creates) problems.push(`${where}: step ${ref} does not create anything, so {{${ref}.id}} has no value`);
        dependsOn.add(ref);
      }
    }
    try {
      await gateway.validate(step.tool, step.args, { planning: true });
    } catch (err) {
      if (err instanceof GatewayError) problems.push(`${where}: ${err.message}`);
      else throw err;
    }
    seen.set(step.id, { creates: Boolean(spec?.creates) });
    if (!spec) continue;
    if (spec.creates) creations++;
    if (spec.tier === "destructive") deletions++;
    steps.push({
      ...step,
      tier: spec.tier,
      group: spec.group,
      destructive: spec.tier === "destructive",
      undoable: Boolean(spec.creates) || UNDOABLE_EDITS.has(step.tool),
      dependsOn: [...dependsOn],
    });
    if (spec.tier === "read") warnings.push(`${where} only reads data; it will run but changes nothing.`);
  }

  if (plan.steps.length > limits.maxToolCalls) problems.push(`plan has ${plan.steps.length} steps; the limit is ${limits.maxToolCalls}`);
  if (creations > limits.maxCreations) problems.push(`plan creates ${creations} objects; the limit is ${limits.maxCreations}`);
  if (deletions > limits.maxDeletions) problems.push(`plan deletes ${deletions} objects; the limit is ${limits.maxDeletions}`);

  if (problems.length) throw new PlanValidationError(problems);

  const requiresConfirmation = steps.some((s) => s.destructive);
  if (requiresConfirmation) warnings.push("Deleted channels, roles and messages cannot be restored by Undo.");
  return {
    summary: plan.summary,
    steps,
    requiresConfirmation,
    confirmationPhrase: requiresConfirmation ? opts.confirmationPhrase : null,
    warnings,
  };
}
