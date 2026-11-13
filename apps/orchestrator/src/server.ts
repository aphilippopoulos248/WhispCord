import "./nodeVersion.js";
import Anthropic from "@anthropic-ai/sdk";
import { buildApp, supabaseTokenVerifier } from "./app.js";
import { loadConfig } from "./config.js";
import { Maintenance } from "./jobs.js";
import { LiveWatchService } from "./live/watchService.js";
import { McpDiscordClient, WhispcordInternal } from "./mcp/client.js";
import { RunEvents } from "./runs/events.js";
import { RunService } from "./runs/service.js";
import { SupabaseStore } from "./store/supabase.js";

const config = loadConfig();
if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the API server. For a local test without a database, use `npm run cli`.");
  process.exit(1);
}

const store = new SupabaseStore(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
const mcp = new McpDiscordClient(config.DISCORD_MCP_URL, config.WHISPCORD_MCP_SECRET);
const internal = new WhispcordInternal(mcp);
const events = new RunEvents();
const anthropic = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
const live = new LiveWatchService({ store, mcp, internal, anthropic, config, log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) } });

const app = await buildApp({
  config,
  store,
  internal,
  events,
  live,
  runs: new RunService({ store, mcp, internal, anthropic, events, config, live, log: (m, e) => app.log.error({ err: e }, m) }),
  verifyToken: supabaseTokenVerifier(store.db),
});

if (!anthropic) app.log.warn("ANTHROPIC_API_KEY is not set: runs can't be planned until it is.");

// Runs are executed in-process, so anything mid-flight when we last stopped can't resume.
const interrupted = await store.failInterruptedRuns("Whispcord restarted while this run was in progress. Check your server, then retry or undo.");
if (interrupted) app.log.warn(`Marked ${interrupted} interrupted run(s) as failed`);

// Fail loudly at boot if discord-mcp is unreachable or the fork's Whispcord tools are missing.
try {
  const tools = await mcp.listTools();
  const missing = ["check_member_permissions", "get_bot_status", "get_guild_snapshot"].filter((t) => !tools.some((d) => d.name === t));
  if (missing.length) app.log.warn(`discord-mcp is missing Whispcord tools: ${missing.join(", ")}. Is it running the Whispcord fork?`);
  else app.log.info(`Connected to discord-mcp (${tools.length} tools)`);
} catch (err) {
  app.log.warn(`discord-mcp not reachable at ${config.DISCORD_MCP_URL} yet: ${(err as Error).message}`);
}

const maintenance = new Maintenance(store, internal, config, {
  info: (m) => app.log.info(m),
  warn: (m) => app.log.warn(m),
});
maintenance.start();

// Tells discord-mcp which servers have live watches, then re-syncs every minute.
await live.start().catch((err: Error) => app.log.warn(`Live watch couldn't start yet: ${err.message}`));

await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    maintenance.stop();
    live.stop();
    await app.close();
    process.exit(0);
  });
}
