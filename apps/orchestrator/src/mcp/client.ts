import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BotStatusSchema,
  GuildSnapshotSchema,
  MemberPermissionsSchema,
  type BotStatus,
  type GuildSnapshot,
  type MemberPermissions,
} from "@whispcord/shared";

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

/**
 * The minimal surface the gateway needs. The real implementation talks MCP; tests use a fake.
 */
export interface DiscordMcp {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * Spring AI JSON-encodes tool results that are plain Java Strings, so prose arrives as a quoted
 * JSON string ("Retrieved 4 channels:\n- ...") while tools that already return JSON come through
 * as-is. Unwrap the former so parsers and Claude see real text with real newlines.
 */
export function normalizeToolText(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not a JSON string literal; leave it alone.
    }
  }
  return text;
}

export class McpDiscordClient implements DiscordMcp {
  private client: Client | null = null;
  private tools: McpToolDef[] | null = null;

  constructor(
    private readonly url: string,
    private readonly secret: string,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const headers: Record<string, string> = {};
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;
    const transport = new StreamableHTTPClientTransport(new URL(this.url), { requestInit: { headers } });
    const client = new Client({ name: "whispcord-orchestrator", version: "0.1.0" });
    transport.onclose = () => {
      // Force a reconnect on next use if discord-mcp restarts.
      this.client = null;
    };
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (this.tools) return this.tools;
    const client = await this.connect();
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema as McpToolDef["inputSchema"] });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = out;
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    let client = await this.connect();
    let res;
    try {
      res = await client.callTool({ name, arguments: args });
    } catch (err) {
      // One retry on a dropped session.
      this.client = null;
      client = await this.connect();
      res = await client.callTool({ name, arguments: args });
    }
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => normalizeToolText(c.text!))
      .join("\n");
    return { text, isError: Boolean(res.isError) };
  }
}

/** Typed wrappers for the fork's Whispcord-internal tools. */
export class WhispcordInternal {
  constructor(private readonly mcp: DiscordMcp) {}

  private async json(tool: string, args: Record<string, string>): Promise<unknown> {
    const res = await this.mcp.callTool(tool, args);
    if (res.isError) throw new Error(`${tool} failed: ${res.text}`);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new Error(`${tool} returned non-JSON output: ${res.text.slice(0, 200)}`);
    }
  }

  async memberPermissions(guildId: string, userId: string): Promise<MemberPermissions> {
    return MemberPermissionsSchema.parse(await this.json("check_member_permissions", { guildId, userId }));
  }

  async botStatus(guildId: string): Promise<BotStatus> {
    return BotStatusSchema.parse(await this.json("get_bot_status", { guildId }));
  }

  async snapshot(guildId: string): Promise<GuildSnapshot> {
    return GuildSnapshotSchema.parse(await this.json("get_guild_snapshot", { guildId }));
  }
}
