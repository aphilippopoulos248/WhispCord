import { botRoleOk } from "@whispcord/shared";
import type { Config } from "./config.js";
import type { WhispcordInternal } from "./mcp/client.js";
import type { Store } from "./store/types.js";

export interface MaintenanceLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Periodic background work:
 * - reconcile: the bot-left webhook can be missed (orchestrator down, network blip), so check
 *   every connected server directly and mark ones the bot has left as disconnected.
 * - purge: delete disconnected servers' data after the retention period and expired connect
 *   attempts (data minimisation; see docs/discord-policies.md).
 */
export class Maintenance {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly internal: WhispcordInternal,
    private readonly config: Config,
    private readonly log: MaintenanceLog,
  ) {}

  start(): void {
    const minutes = this.config.RECONCILE_INTERVAL_MINUTES;
    if (minutes <= 0) return;
    // First pass shortly after boot, then on the interval.
    setTimeout(() => void this.tick(), 30_000).unref();
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcile();
      await this.purge();
    } catch (err) {
      this.log.warn(`Maintenance failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async reconcile(): Promise<{ checked: number; disconnected: number }> {
    const servers = await this.store.listConnectedServers();
    let disconnected = 0;
    // Small batches: each check is a cheap in-memory JDA lookup, but stay gentle anyway.
    for (let i = 0; i < servers.length; i += 5) {
      await Promise.all(
        servers.slice(i, i + 5).map(async (server) => {
          try {
            const status = await this.internal.botStatus(server.guildId);
            if (!status.inGuild) {
              await this.store.updateServer(server.guildId, { status: "disconnected" });
              disconnected++;
              return;
            }
            const ok = botRoleOk(status);
            const patch: Parameters<Store["updateServer"]>[1] = {};
            if (ok !== server.botRoleOk) patch.botRoleOk = ok;
            if (status.guildName && status.guildName !== server.name) patch.name = status.guildName;
            if (Object.keys(patch).length) await this.store.updateServer(server.guildId, patch);
          } catch (err) {
            // discord-mcp unreachable: don't mark anything disconnected on our own failure.
            this.log.warn(`Could not check server ${server.guildId}: ${(err as Error).message}`);
          }
        }),
      );
    }
    if (disconnected) this.log.info(`Marked ${disconnected} server(s) disconnected (bot no longer present)`);
    return { checked: servers.length, disconnected };
  }

  async purge(): Promise<{ servers: number; attempts: number }> {
    const before = new Date(Date.now() - this.config.DISCONNECTED_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const servers = await this.store.purgeDisconnectedServers(before);
    const attempts = await this.store.purgeExpiredConnectAttempts();
    const findingsBefore = new Date(Date.now() - this.config.FINDINGS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const findings = await this.store.clearMessageSearchBefore(findingsBefore);
    if (findings) this.log.info(`Cleared message-search results from ${findings} run(s) older than ${this.config.FINDINGS_RETENTION_DAYS} days`);
    if (servers) this.log.info(`Purged ${servers} server(s) disconnected for over ${this.config.DISCONNECTED_RETENTION_DAYS} days`);
    return { servers, attempts };
  }
}
