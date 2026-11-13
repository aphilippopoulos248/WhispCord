# Whispcord setup

## 1. Discord application (build plan, Phase 0)

1. Create an application named **Whispcord** in the Developer Portal. Add Terms of Service and Privacy Policy URLs.
2. **Bot:** create the bot, copy the token (`DISCORD_TOKEN`), and turn **Public Bot** off while developing.
3. **Privileged Gateway Intents:** enable **Server Members**. Leave Message Content off.
4. **OAuth2:** note the Client ID and Client Secret. Add these redirects: `http://localhost:3000/connect/callback` and your Supabase auth callback (`https://<project>.supabase.co/auth/v1/callback`).
5. Permission integers (in `packages/shared/src/permissions.ts`): Builder `27648920593`, Builder + Moderation `1127294766103`.

## 2. Supabase

1. Create a project. Under Auth → Providers, enable **Discord** with the client ID and secret.
2. Apply `supabase/migrations/0001_init.sql`, either with `supabase db push` or by pasting it into the SQL editor.
3. Copy the URL, the anon key (web) and the service-role key (orchestrator only).

## 3. Run locally

Requires **Node.js 22.12+** (`.nvmrc`). With nvm for Windows: `nvm install 22`, then `nvm use <version>`. The apps refuse to start on older versions.

All local settings live in **one file: `.env` at the repo root** (template: `.env.example`).
discord-mcp, the orchestrator and the web app all read it.

```powershell
npm install
copy .env.example .env      # then fill in the >>> values

# Terminal 1: discord-mcp fork (loads only its own keys from .env)
powershell -ExecutionPolicy Bypass -File scripts\run-discord-mcp.ps1
# Terminal 2
npm run dev:orchestrator
# Terminal 3: http://localhost:3000
npm run dev:web
```

### M1 proof of concept (no database or web app)

Add the bot to your test server by hand using the Builder-tier invite URL, then run:

```bash
npm run cli -- --guild <serverId> --user <yourDiscordUserId> \
  "Create a Gaming category with general, clips and LFG text channels and a Squad voice channel"
```

The CLI prints the plan, asks for approval, runs the plan through the gateway, and lists the undo actions.

## 4. Deploy

- **Web:** Vercel (`apps/web`). Set the `NEXT_PUBLIC_*` variables.
- **Backend:** Railway (below), or `infra/docker-compose.yml` on Fly.io or a VPS. Only the orchestrator gets a public HTTPS endpoint. discord-mcp stays on the private network, with `WHISPCORD_MCP_SECRET` set.
- Before going public, work through the checklist in [`discord-policies.md`](./discord-policies.md).

### Backend on Railway

Two services from this GitHub repo, configured by `railway/discord-mcp.json` and `railway/orchestrator.json`. Both are built from the repo root with their Dockerfiles. Keep each at **one replica**: discord-mcp holds the bot's Discord connection, and the orchestrator keeps live-watch batches and browser streams in memory.

1. **Project:** in Railway, create a project, then add **two services from the GitHub repo**. Name them exactly `discord-mcp` and `orchestrator`. The variable references below use these names.
2. **Config file:** for each service, open Settings, set **Config-as-code → Railway config file** to `/railway/discord-mcp.json` or `/railway/orchestrator.json`, and turn on **Wait for CI**. Pushes to `main` then deploy only after CI passes.
3. **Shared variable:** in Project Settings → Shared Variables, add `WHISPCORD_MCP_SECRET`, a long random string (for example `openssl rand -hex 32`).
4. **discord-mcp variables:**

   ```
   SPRING_PROFILES_ACTIVE=http
   SERVER_ADDRESS=::
   DISCORD_TOKEN=<bot token>
   DISCORD_GUILD_ID=
   WHISPCORD_MCP_SECRET=${{shared.WHISPCORD_MCP_SECRET}}
   WHISPCORD_EVENTS_WEBHOOK_URL=http://${{orchestrator.RAILWAY_PRIVATE_DOMAIN}}:8787/internal/discord-events
   WHISPCORD_MESSAGE_CONTENT=true          # only if Message Content Intent is on in the Developer Portal
   JAVA_TOOL_OPTIONS=-Xmx512m
   ```

   **Do not generate a public domain** for discord-mcp. `SERVER_ADDRESS=::` makes it listen on Railway's private network.
5. **orchestrator variables:**

   ```
   HOST=::
   PORT=8787
   WEB_ORIGIN=https://<your-site>.vercel.app
   DISCORD_MCP_URL=http://${{discord-mcp.RAILWAY_PRIVATE_DOMAIN}}:8085/mcp
   WHISPCORD_MCP_SECRET=${{shared.WHISPCORD_MCP_SECRET}}
   DISCORD_CLIENT_ID=<application id>
   DISCORD_BOT_REDIRECT_URI=https://<your-site>.vercel.app/connect/callback
   ANTHROPIC_API_KEY=<key>
   SUPABASE_URL=<project url>
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   ```

   Optional: `WHISPCORD_PLANNER_MODEL`, `LIVE_WATCH_*` and the other limits in `.env.example`. Then, in Settings → Networking, **generate a domain** on port 8787 (or add your own, like `api.yourdomain.com`).
6. **Vercel:** set `NEXT_PUBLIC_ORCHESTRATOR_URL` to the orchestrator's domain and `NEXT_PUBLIC_SITE_URL` to the site's URL, then redeploy.
7. **Discord and Supabase:**
   - Discord Developer Portal → OAuth2: add `https://<your-site>.vercel.app/connect/callback` as a redirect.
   - Supabase → Authentication → URL Configuration: set the Site URL and add the redirect URL.
   - Apply every migration in `supabase/migrations`.
8. **Check:** `https://<orchestrator-domain>/health` returns `{"ok":true,"discordMcp":"up"}`. Railway's deploy check uses `/livez`, which only confirms the process is up, so a bot restart doesn't fail an orchestrator deploy.

Size: discord-mcp is capped at a 512 MB heap (about 700 MB in total); the orchestrator uses about 150 MB.
