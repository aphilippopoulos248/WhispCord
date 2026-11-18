<div align="center">
  <img src="assets/whispcord-icon.svg" width="120" alt="Whispcord" />
  <h1>Whispcord</h1>
  <p><strong>Manage your Discord server in plain English.</strong></p>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</div>

---

Whispcord is a web app for Discord server owners. You describe what you want ("set up a Gaming category with general, clips and LFG channels and a Squad voice channel"). A Claude agent turns that into a step-by-step plan, you approve it, and the Whispcord bot carries it out. Every run is saved to history, and anything Whispcord created can be undone.

## Features

- **Plain-English changes.** Create and edit categories, channels, roles, permission overrides, emojis, events, invites and webhooks.
- **Plan first, then run.** You see every action before anything changes. Nothing is written to your server until you approve it, and deletions need a typed confirmation.
- **History and undo.** Each run is logged, and Whispcord can undo the things it created.
- **Message search (opt-in).** Find messages that break your rules (spam, slurs, scams) and review them before acting.
- **Live watch (opt-in).** Keep an eye on chosen channels as new messages (and images) arrive. It flags problems and can delete high-severity ones automatically, within an hourly limit.
- **Permission tiers.** You choose what Whispcord may do on your server: Build, Deletions, Moderation, Messaging, Message search, Live watch. Only Build and Deletions are on by default.

## Using Whispcord

1. **Sign in** with Discord.
2. **Pick your server.** You need the **Manage Server** permission on it.
3. **Add the bot.** Click **Add Whispcord to server**. Discord opens with your server and the right permissions already selected. Approve it, and the server shows as **Connected**.
4. **Type a request**, for example:
   - *"Create a Moderator role that can manage messages in #general and #clips."*
   - *"Make an Events category with an announcements channel only admins can post in."*
   - *"Rename #off-topic to #lounge and move it to the top."*
5. **Review the plan.** Whispcord lists every action it will take. Click **Run** to apply it, or change your request.
6. **Watch it run.** Actions execute live with a progress log.
7. **Undo if needed.** Open the run in **History** and click **Undo** to remove what it created.

To use message search or live watch, switch on those tiers in the server's settings first. They send message text to Anthropic for classification, so they stay off until you turn them on.

### What Whispcord won't do

- Act on any server other than the one you're working in.
- Give anyone permissions you don't have yourself, touch roles at or above your highest role, or grant Administrator.
- Change anything without your approval.
- Send DMs or look up users outside your server.
- Treat message text, channel names or role names as instructions.

## How it works

```
Browser (Next.js)  ──►  Orchestrator (Node/TS)  ──►  discord-mcp (Java, private)  ──►  Discord
                         │  Claude planner
                         │  Gateway: server lock + tool allowlist + permission checks
                         └► Supabase (auth, servers, runs, history)
```

- **Web app** (`apps/web`): sign-in, server connection, prompt box, plan preview, history.
- **Orchestrator** (`apps/orchestrator`): asks Claude for a plan, checks every step through the gateway, runs it, and records undo actions.
- **discord-mcp** (`src/main/java`): a fork of [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp) that holds the bot token and talks to Discord. It's never exposed publicly.
- **Shared** (`packages/shared`): permission bitfields, the tool allowlist and tiers, and the plan schema.

## Running it yourself

You need **Node.js 22.12+**, **Java 17+**, a Discord application with a bot, a Supabase project and an Anthropic API key. The full walkthrough is in [`docs/setup.md`](./docs/setup.md).

```bash
npm install
cp .env.example .env          # fill in the values

# Terminal 1: discord-mcp
powershell -ExecutionPolicy Bypass -File scripts/run-discord-mcp.ps1
# Terminal 2: orchestrator (http://localhost:8787)
npm run dev:orchestrator
# Terminal 3: web app (http://localhost:3000)
npm run dev:web
```

### Quick test from the command line

No database or web app needed. Add the bot to a test server, then:

```bash
npm run cli -- --guild <serverId> --user <yourDiscordUserId> --dry-run \
  "Create a Gaming category with general, clips and LFG text channels"
```

Drop `--dry-run` to approve and run the plan for real.

### Development

```bash
npm test             # unit tests (shared + orchestrator)
npm run typecheck
mvn -q compile       # Java fork
```

### Deploying

The repo includes configs for Railway (`railway/`) and Docker Compose (`infra/docker-compose.yml`). Only the web app and the orchestrator should be public; discord-mcp stays on a private network. See [Deploy in `docs/setup.md`](./docs/setup.md#4-deploy).

## Privacy and Discord policies

Whispcord sends server data only to Anthropic for inference and never uses it for training or evals. Message text never reaches the planning agent; only a separate classifier with no tools sees it. See [`docs/discord-policies.md`](./docs/discord-policies.md) for the full list of rules and the code that enforces each one.

## Credits

Whispcord is built on [SaseQ/discord-mcp](https://github.com/SaseQ/discord-mcp), an MCP server for Discord built with [JDA](https://jda.wiki/), also MIT-licensed.

## License

Whispcord is released under the [MIT License](./LICENSE).
