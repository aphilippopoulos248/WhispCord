import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  /** Public URL of the web app, used for CORS and redirects. */
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),

  /** discord-mcp fork, reachable on the private network only. */
  DISCORD_MCP_URL: z.string().url().default("http://localhost:8085/mcp"),
  /** Shared secret checked by the fork's McpSharedSecretFilter (and on /internal webhooks). */
  WHISPCORD_MCP_SECRET: z.string().default(""),

  DISCORD_CLIENT_ID: z.string().default(""),
  /** Where Discord sends the user after adding the bot (the web app's /connect/callback). */
  DISCORD_BOT_REDIRECT_URI: z.string().url().default("http://localhost:3000/connect/callback"),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** The build plan specifies Sonnet for planning. */
  WHISPCORD_PLANNER_MODEL: z.string().default("claude-sonnet-5-5"),
  WHISPCORD_PLANNER_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Message search classifier (the build plan specifies Haiku for cheap classification). */
  WHISPCORD_CLASSIFIER_MODEL: z.string().default("claude-haiku-5-5"),
  MAX_MESSAGES_SCANNED_PER_RUN: z.coerce.number().default(1000),
  /** Message excerpts found by searches are cleared from run history after this many days. */
  FINDINGS_RETENTION_DAYS: z.coerce.number().default(30),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  MAX_TOOL_CALLS_PER_RUN: z.coerce.number().default(60),
  MAX_CREATIONS_PER_RUN: z.coerce.number().default(50),
  MAX_DELETIONS_PER_RUN: z.coerce.number().default(10),
  MAX_RUNS_PER_SERVER_PER_HOUR: z.coerce.number().default(20),
  MAX_RUNS_PER_USER_PER_HOUR: z.coerce.number().default(30),

  /** How often to check the bot is still in each connected server (0 disables). */
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().default(15),
  /** Disconnected servers and their run history are deleted after this many days. */
  DISCONNECTED_RETENTION_DAYS: z.coerce.number().default(30),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return EnvSchema.parse(env);
}
