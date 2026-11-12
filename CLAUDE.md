# Whispcord

Whispcord lets a Discord server owner manage their server in plain English. A Claude agent plans changes, the owner approves them, and the actions run through a fork of **SaseQ/discord-mcp** using one shared bot.

- Product and architecture plan: [`Whispcord — Full Build Plan.md`](./Whispcord%20—%20Full%20Build%20Plan.md)
- **Discord rules we must follow:** [`docs/discord-policies.md`](./docs/discord-policies.md). Read it before any change that touches Discord data, permissions, intents, messaging, what is sent to Anthropic, or data retention. Its compliance checklist maps each obligation to the code that enforces it. Keep both in sync.
- Setup and running: [`docs/setup.md`](./docs/setup.md)

## Layout

| Path | What |
| --- | --- |
| `src/main/java/dev/saseq/**` | Upstream discord-mcp (Java 17, Spring Boot 4, Spring AI MCP, JDA). Keep edits minimal so upstream merges stay easy |
| `src/main/java/dev/saseq/whispcord/` | Fork additions: `check_member_permissions`, `get_bot_status`, `get_guild_snapshot` (JSON output), `/mcp` shared-secret filter, guild join/leave webhook |
| `packages/shared` | Permission bitfields, tool allowlist and tiers, plan schema, snapshot types (TS source, no build step) |
| `apps/orchestrator` | Node/TS API + agent: MCP client, **gateway** (guild lock + tool filter), planner (Claude), executor, undo, Supabase store, CLI |
| `apps/web` | Next.js 16 App Router + Tailwind 4 + Supabase Auth (Discord) |
| `supabase/migrations` | Postgres schema + RLS |
| `infra/` | docker-compose: discord-mcp + orchestrator on a private network |

## Commands

```bash
npm install                          # workspaces
npm test                             # vitest: shared + orchestrator (gateway tests are the critical ones)
npm run typecheck
npm run dev:orchestrator             # reads the repo-root .env
npm run dev:web                      # reads the repo-root .env (via next.config.ts)
powershell -File scripts\run-discord-mcp.ps1   # discord-mcp; loads only its own keys from .env
npm run cli -- --guild <id> --user <discordUserId> [--dry-run] "prompt"   # M1 path: no DB or web needed
mvn -o -q compile                    # Java fork (drop -o if dependencies aren't cached)
```

Node 22+ (Supabase SDK requirement). Java 17+.

## Security rules (do not weaken)

1. **Never let the model choose the server.** `guildId` is removed from Claude's tool schemas and injected by `GuildGateway`. Every ID argument must belong to the run's guild or have been created in this run.
2. **Unlisted tools are blocked.** New upstream tools stay invisible until they're added to `TOOL_SPECS` in `packages/shared/src/toolTiers.ts` with a tier. `restricted` (DMs, user lookups) is never enabled.
3. **Live permission check on every run** (`check_member_permissions`), not just at connect time.
4. **No escalation:** a user can't grant permissions they lack or touch roles at or above their highest role. Whispcord never grants Administrator.
5. **Human approval before any write.** Deletions need typed confirmation. Undo may delete only what Whispcord created.
6. **Server content is untrusted data.** Channel and role names go to Claude quoted inside `<server_snapshot>`, never as instructions.
7. **The bot token lives only in discord-mcp.** The MCP endpoint is never public.

Any change to these needs a matching test in `apps/orchestrator/test/gateway.test.ts` or `plan.test.ts`.

## Conventions

- Planner model: `WHISPCORD_PLANNER_MODEL` (default `claude-sonnet-5-5`, as the build plan specifies Sonnet for planning). It is called through `client.beta.messages.create` with server-side refusal `fallbacks: "default"`.
- discord-mcp returns prose, and Spring AI JSON-encodes it (a quoted string with escaped newlines); `normalizeToolText` in `apps/orchestrator/src/mcp/client.ts` unwraps it. ID extraction and undo parsers live in `apps/orchestrator/src/gateway/results.ts`; update them if upstream changes a response format.
- Claude can only *call* read tools while planning; write actions reach it as the `<available_actions>` catalog in the first message (`renderActionCatalog`). New allowlisted tools appear there automatically.
- Java: put new behaviour in `dev.saseq.whispcord`, not in upstream services.
- Don't send customer data anywhere except Anthropic for inference. Never use it for evals or training (see policies doc).
