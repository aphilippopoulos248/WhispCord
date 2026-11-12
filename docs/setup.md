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
- **Backend:** `infra/docker-compose.yml` on Railway, Fly.io or a VPS. Only the orchestrator gets a public HTTPS endpoint. discord-mcp stays on the private network, with `WHISPCORD_MCP_SECRET` set.
- Before going public, work through the checklist in [`discord-policies.md`](./discord-policies.md).
