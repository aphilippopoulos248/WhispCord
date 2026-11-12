import type Anthropic from "@anthropic-ai/sdk";
import {
  P,
  isSubset,
  isToolAllowed,
  parsePermissions,
  toolSpec,
  type CreatedObjectType,
  type GuildSnapshot,
  type MemberPermissions,
  type RefKind,
  type Tier,
} from "@whispcord/shared";
import type { DiscordMcp, McpToolDef, ToolCallResult, WhispcordInternal } from "../mcp/client.js";
import { extractCreatedId } from "./results.js";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | "tool_blocked"
      | "bad_args"
      | "foreign_id"
      | "limit"
      | "escalation"
      | "confirmation_required"
      | "not_authorized",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayLimits {
  maxToolCalls: number;
  maxCreations: number;
  maxDeletions: number;
}

export interface GatewayCallLog {
  tool: string;
  args: Record<string, string>;
  result: ToolCallResult | null;
  error: string | null;
  durationMs: number;
  createdId: string | null;
  createdType: CreatedObjectType | null;
}

export interface GatewayOptions {
  mcp: DiscordMcp;
  internal: WhispcordInternal;
  toolDefs: McpToolDef[];
  guildId: string;
  /** Live permissions of the human who started the run. */
  requester: MemberPermissions;
  enabledTiers: readonly Tier[];
  snapshot: GuildSnapshot;
  limits: GatewayLimits;
  /** Destructive tools only run when the user typed the confirmation phrase for this run. */
  destructiveConfirmed?: boolean;
  /** Undo runs may delete objects Whispcord created earlier; seed them as known. */
  knownCreated?: Array<{ type: CreatedObjectType; id: string }>;
  /**
   * Undo mode: deletions are allowed without typed confirmation, but only of objects listed in
   * knownCreated (things Whispcord itself made).
   */
  undoMode?: boolean;
  onCall?: (log: GatewayCallLog) => void | Promise<void>;
}

const GUILD_ARG = "guildId";

/** Which argument identifies the object a destructive tool deletes. */
const DELETE_TARGET: Record<string, [CreatedObjectType, string]> = {
  delete_channel: ["channel", "channelId"],
  delete_category: ["category", "categoryId"],
  delete_role: ["role", "roleId"],
  delete_webhook: ["webhook", "webhookId"],
  delete_invite: ["invite", "inviteCode"],
  delete_emoji: ["emoji", "emojiId"],
  delete_guild_scheduled_event: ["event", "eventId"],
};

const hasPlaceholder = (v: string) => /\{\{.*\}\}/.test(v);

/**
 * Sits between Claude and discord-mcp. Every tool call for a run goes through here:
 * - only allowlisted tools in enabled tiers can be called
 * - guildId is removed from Claude's schemas and injected server-side
 * - unexpected args are rejected; referenced IDs must belong to the run's guild
 * - the requester can never do through Whispcord what they couldn't do in Discord
 * - per-run limits are enforced
 */
export class GuildGateway {
  readonly guildId: string;
  private readonly defs: Map<string, McpToolDef>;
  private readonly created = new Map<CreatedObjectType, Set<string>>();
  private readonly memberCache = new Map<string, boolean>();
  private counts = { calls: 0, creations: 0, deletions: 0 };
  private destructiveConfirmed: boolean;
  private readonly tiers: readonly Tier[];

  constructor(private readonly opts: GatewayOptions) {
    if (!opts.requester.canManageServer) {
      throw new GatewayError("You need Manage Server on this server to use Whispcord.", "not_authorized");
    }
    if (opts.snapshot.guildId !== opts.guildId) {
      throw new GatewayError("Snapshot does not belong to this guild", "foreign_id");
    }
    this.guildId = opts.guildId;
    this.defs = new Map(opts.toolDefs.map((d) => [d.name, d]));
    this.destructiveConfirmed = opts.destructiveConfirmed ?? false;
    this.tiers = opts.undoMode && !opts.enabledTiers.includes("destructive")
      ? [...opts.enabledTiers, "destructive"]
      : opts.enabledTiers;
    for (const k of opts.knownCreated ?? []) this.registerCreated(k.type, k.id);
  }

  get snapshot(): GuildSnapshot {
    return this.opts.snapshot;
  }

  get usage() {
    return { ...this.counts };
  }

  confirmDestructive(): void {
    this.destructiveConfirmed = true;
  }

  registerCreated(type: CreatedObjectType, id: string): void {
    const set = this.created.get(type) ?? new Set<string>();
    set.add(id);
    this.created.set(type, set);
  }

  /** Tools available to Claude, optionally narrowed to some tiers, with guildId stripped. */
  claudeTools(onlyTiers?: readonly Tier[]): Anthropic.Beta.Messages.BetaTool[] {
    const out: Anthropic.Beta.Messages.BetaTool[] = [];
    for (const def of this.defs.values()) {
      const spec = toolSpec(def.name);
      if (!spec || !isToolAllowed(def.name, this.tiers)) continue;
      if (onlyTiers && !onlyTiers.includes(spec.tier)) continue;
      out.push({
        name: def.name,
        description: def.description ?? def.name,
        input_schema: this.schemaForClaude(def),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Allowed tool names (any tier), for plan validation. */
  allowedToolNames(): string[] {
    return [...this.defs.keys()].filter((n) => isToolAllowed(n, this.tiers));
  }

  schemaForClaude(def: McpToolDef): Anthropic.Beta.Messages.BetaTool.InputSchema {
    const properties = { ...(def.inputSchema.properties ?? {}) };
    delete properties[GUILD_ARG];
    const required = (def.inputSchema.required ?? []).filter((r) => r !== GUILD_ARG);
    return { type: "object", properties, required, additionalProperties: false } as Anthropic.Beta.Messages.BetaTool.InputSchema;
  }

  /**
   * Static validation that doesn't depend on earlier steps having run: tool allowlist and arg
   * shape. Placeholder values ({{s1.id}}) are accepted here and checked again at execution.
   */
  checkShape(tool: string, args: Record<string, unknown>): Record<string, string> {
    const def = this.defs.get(tool);
    if (!def || !isToolAllowed(tool, this.tiers)) {
      throw new GatewayError(`Tool "${tool}" is not available for this server.`, "tool_blocked");
    }
    const props = def.inputSchema.properties ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      if (k === GUILD_ARG) throw new GatewayError("guildId is set by Whispcord and cannot be provided.", "foreign_id");
      if (!(k in props)) throw new GatewayError(`Unexpected argument "${k}" for ${tool}.`, "bad_args");
      if (v === null || v === undefined) continue;
      if (typeof v === "object") throw new GatewayError(`Argument "${k}" for ${tool} must be a scalar.`, "bad_args");
      out[k] = String(v);
    }
    for (const r of def.inputSchema.required ?? []) {
      if (r === GUILD_ARG) continue;
      if (!(r in out) || out[r] === "") throw new GatewayError(`Missing required argument "${r}" for ${tool}.`, "bad_args");
    }
    return out;
  }

  /**
   * Full validation of a call. With `planning: true` (plan validation, before anything has run)
   * placeholder values are skipped and destructive confirmation isn't required yet.
   */
  async validate(tool: string, rawArgs: Record<string, unknown>, opts: { planning?: boolean } = {}): Promise<Record<string, string>> {
    const args = this.checkShape(tool, rawArgs);
    const spec = toolSpec(tool)!;
    if (!opts.planning) {
      for (const [k, v] of Object.entries(args)) {
        if (hasPlaceholder(v)) throw new GatewayError(`Unresolved placeholder in ${k}.`, "bad_args");
      }
    }

    if (spec.tier === "destructive") {
      if (this.opts.undoMode) {
        const target = DELETE_TARGET[tool];
        const id = target ? args[target[1]] : undefined;
        if (!target || !id || (!hasPlaceholder(id) && !this.isCreated(target[0], id))) {
          throw new GatewayError("Undo can only delete objects Whispcord created.", "foreign_id");
        }
      } else if (!opts.planning && !this.destructiveConfirmed) {
        throw new GatewayError(`"${tool}" deletes data and needs typed confirmation.`, "confirmation_required");
      }
    }

    for (const [arg, kind] of Object.entries(spec.refs ?? {})) {
      const value = args[arg];
      if (value === undefined || (opts.planning && hasPlaceholder(value))) continue;
      await this.assertRef(kind, value, arg, args);
    }
    // delete_channel_permission_overwrite: targetId kind depends on targetType.
    if (tool === "delete_channel_permission_overwrite") {
      const kind: RefKind = args.targetType === "member" ? "member" : "role";
      if (args.targetType !== "role" && args.targetType !== "member") {
        throw new GatewayError('targetType must be "role" or "member".', "bad_args");
      }
      if (!(opts.planning && hasPlaceholder(args.targetId ?? ""))) {
        await this.assertRef(kind, args.targetId ?? "", "targetId", args);
      }
    }

    this.assertNoEscalation(tool, args);
    return args;
  }

  /** Validate, enforce limits, inject guildId, execute, and record. */
  async call(tool: string, rawArgs: Record<string, unknown>): Promise<ToolCallResult & { createdId: string | null }> {
    const spec = toolSpec(tool);
    const started = Date.now();
    let args: Record<string, string> = {};
    try {
      args = await this.validate(tool, rawArgs);
      this.enforceLimits(tool);
    } catch (err) {
      await this.opts.onCall?.({
        tool, args: Object.fromEntries(Object.entries(rawArgs ?? {}).map(([k, v]) => [k, String(v)])),
        result: null, error: (err as Error).message, durationMs: 0, createdId: null, createdType: null,
      });
      throw err;
    }

    const def = this.defs.get(tool)!;
    const finalArgs: Record<string, string> = { ...args };
    if (def.inputSchema.properties && GUILD_ARG in def.inputSchema.properties) finalArgs[GUILD_ARG] = this.guildId;

    this.counts.calls++;
    if (spec?.creates) this.counts.creations++;
    if (spec?.tier === "destructive") this.counts.deletions++;

    let result: ToolCallResult;
    try {
      result = await this.opts.mcp.callTool(tool, finalArgs);
    } catch (err) {
      result = { text: (err as Error).message, isError: true };
    }

    let createdId: string | null = null;
    if (!result.isError && spec?.creates) {
      createdId = extractCreatedId(tool, result.text);
      if (createdId) this.registerCreated(spec.creates, createdId);
    }
    if (!result.isError && spec?.tier === "destructive") this.forget(tool, args);

    await this.opts.onCall?.({
      tool, args, result, error: result.isError ? result.text : null,
      durationMs: Date.now() - started, createdId, createdType: createdId ? spec!.creates! : null,
    });
    return { ...result, createdId };
  }

  private enforceLimits(tool: string): void {
    const spec = toolSpec(tool)!;
    const { limits } = this.opts;
    if (this.counts.calls + 1 > limits.maxToolCalls) {
      throw new GatewayError(`This run hit the limit of ${limits.maxToolCalls} actions.`, "limit");
    }
    if (spec.creates && this.counts.creations + 1 > limits.maxCreations) {
      throw new GatewayError(`This run hit the limit of ${limits.maxCreations} new objects.`, "limit");
    }
    if (spec.tier === "destructive" && this.counts.deletions + 1 > limits.maxDeletions) {
      throw new GatewayError(`This run hit the limit of ${limits.maxDeletions} deletions.`, "limit");
    }
  }

  private isCreated(type: CreatedObjectType, id: string) {
    return this.created.get(type)?.has(id) ?? false;
  }

  private forget(tool: string, args: Record<string, string>) {
    const m = DELETE_TARGET[tool];
    if (m) this.created.get(m[0])?.delete(args[m[1]] ?? "");
  }

  private async assertRef(kind: RefKind, value: string, arg: string, args: Record<string, string>): Promise<void> {
    const s = this.opts.snapshot;
    const fail = () => {
      throw new GatewayError(`${arg}=${value} is not part of this server.`, "foreign_id");
    };
    switch (kind) {
      case "channel":
        if (s.channels.some((c) => c.id === value) || this.isCreated("channel", value) || this.isCreated("category", value)) return;
        return fail();
      case "category":
        if (s.channels.some((c) => c.id === value && c.type === "CATEGORY") || this.isCreated("category", value)) return;
        return fail();
      case "role":
        if (s.roles.some((r) => r.id === value) || this.isCreated("role", value)) return;
        return fail();
      case "emoji":
        if (s.emojis.some((e) => e.id === value) || this.isCreated("emoji", value)) return;
        return fail();
      case "event":
        if (s.events.some((e) => e.id === value) || this.isCreated("event", value)) return;
        return fail();
      case "webhook":
        if (this.isCreated("webhook", value)) return;
        return fail();
      case "invite":
        if (this.isCreated("invite", value)) return;
        return fail();
      case "member": {
        if (!/^\d{17,20}$/.test(value)) return fail();
        let ok = this.memberCache.get(value);
        if (ok === undefined) {
          ok = (await this.opts.internal.memberPermissions(this.guildId, value)).isMember;
          this.memberCache.set(value, ok);
        }
        if (!ok) return fail();
        return;
      }
      case "message":
        // Scoped by channelId, which is validated separately.
        if (!args.channelId) return fail();
        return;
    }
  }

  private roleById(id: string) {
    return this.opts.snapshot.roles.find((r) => r.id === id);
  }

  /** Rule of thumb: never let a user do through the bot what they couldn't do by hand. */
  private assertNoEscalation(tool: string, args: Record<string, string>): void {
    const req = this.opts.requester;
    const held = parsePermissions(req.permissions);
    const isOwner = req.isOwner;

    const checkBits = (raw: string | undefined, label: string) => {
      if (!raw || hasPlaceholder(raw)) return;
      let bits: bigint;
      try {
        bits = parsePermissions(raw);
      } catch {
        throw new GatewayError(`${label} must be a numeric permission bitfield.`, "bad_args");
      }
      if ((bits & P.ADMINISTRATOR) !== 0n) {
        throw new GatewayError("Whispcord never grants Administrator.", "escalation");
      }
      if (!isOwner && !isSubset(bits, held)) {
        throw new GatewayError(`${label} includes permissions you don't have yourself.`, "escalation");
      }
    };

    const checkRoleBelowRequester = (roleId: string | undefined) => {
      if (!roleId || isOwner) return;
      const role = this.roleById(roleId);
      // Roles created in this run sit at the bottom of the list, below the requester.
      if (!role) return;
      if (role.position >= req.highestRolePosition) {
        throw new GatewayError(`The role "${role.name}" is at or above your highest role.`, "escalation");
      }
    };

    switch (tool) {
      case "create_role":
        if (!isOwner && !req.canManageRoles) throw new GatewayError("You need Manage Roles to create roles.", "escalation");
        checkBits(args.permissions, "permissions");
        break;
      case "edit_role":
      case "delete_role":
        if (!isOwner && !req.canManageRoles) throw new GatewayError("You need Manage Roles to change roles.", "escalation");
        checkRoleBelowRequester(args.roleId);
        if (this.roleById(args.roleId ?? "")?.managed) throw new GatewayError("Managed (integration) roles can't be changed.", "escalation");
        checkBits(args.permissions, "permissions");
        break;
      case "assign_role":
      case "remove_role": {
        if (!isOwner && !req.canManageRoles) throw new GatewayError("You need Manage Roles to assign roles.", "escalation");
        checkRoleBelowRequester(args.roleId);
        const role = this.roleById(args.roleId ?? "");
        if (role?.managed || role?.isEveryone) throw new GatewayError("That role can't be assigned.", "escalation");
        if (role && (parsePermissions(role.permissions) & P.ADMINISTRATOR) !== 0n) {
          throw new GatewayError("Whispcord never grants Administrator.", "escalation");
        }
        break;
      }
      case "upsert_role_channel_permissions":
      case "upsert_member_channel_permissions":
        if (!isOwner && !(req.canManageRoles || req.canManageChannels)) {
          throw new GatewayError("You need Manage Roles or Manage Channels to change channel permissions.", "escalation");
        }
        checkBits(args.allowRaw, "allowRaw");
        checkBits(args.denyRaw, "denyRaw");
        if (tool === "upsert_role_channel_permissions") checkRoleBelowRequester(args.roleId);
        break;
    }
  }
}
