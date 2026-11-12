# Discord Terms & Developer Policies — what applies to Whispcord

Whispcord is a public Discord app (one shared bot + a web app that sends server structure to an LLM). Three Discord documents bind us. **They change. Always check the live text before shipping anything that touches Discord data, and update this file when they change.**

| Document | Canonical URL | Version noted here |
| --- | --- | --- |
| Discord Terms of Service | https://discord.com/terms | Effective Sep 29, 2025 (updated Aug 29, 2025) |
| Discord Developer Terms of Service | https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service | Effective Jul 8, 2024 |
| Discord Developer Policy | https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy | Effective Jul 8, 2024 |
| Community Guidelines | https://discord.com/guidelines | — |
| Privileged intents / app verification | Discord Developer Portal → your app → Bot / App Verification | — |

> **How this file was made (2026-11-11):** the Terms of Service were read from discord.com. The two developer documents' support pages blocked automated fetching, so their sections below summarise long-standing provisions plus what a web search confirmed. Items marked **[verify]** must be checked against the live text before launch (Phase 8 of the build plan).

---

## 1. Discord Terms of Service (applies to everyone, incl. our users)

- **Age:** users must be at least 13 (or the minimum age in their country). Whispcord's own ToS must not target under-13s.
- **No spam or automation abuse:** the ToS prohibits *"exploiting, harassing, bullying, spamming, auto-messaging, or auto-dialing people."* This is why DMs are in the `restricted` tier and messaging is opt-in.
- **No scraping / unauthorized modification:** *"scraping our services without our written consent"* and *"unauthorized software designed to modify the services"* are prohibited. Whispcord uses only the official bot API via JDA. **Never** add user-token ("self-bot") features.
- **Third-party apps** must follow the ToS, Community Guidelines, Developer Terms and Developer Policy. Discord *"is not responsible for any third-party services"*, so Whispcord carries the responsibility for what it does.
- **Server owners decide which apps to add** and are responsible for their server settings. This is why Whispcord requires Manage Server and an explicit add-bot step.
- **Enforcement:** Discord may suspend apps or accounts *"with or without notice"* if they create risk. One bad bug in our shared bot can affect every customer.

## 2. Developer Terms of Service (our contract for API access)

- **Scope:** they *"apply to your access to and use of the APIs."* By using the bot token and OAuth2, Whispcord accepts them.
- **Use documented APIs only,** within published **rate limits**. Don't get around limits (e.g. by spreading load across several bot tokens). JDA queues rate limits for us, and our per-run caps keep bursts small.
- **API Data:** use data from the API only to provide Whispcord's features. Store it securely and keep only what is needed. **[verify]** the current retention and deletion clauses. Older versions required deleting a user's data on request and within a short window after they leave. Our plan: keep data only for connected servers, and delete runs and actions when a server is disconnected for good or the user deletes their account.
- **Privacy policy required:** an app that accesses user data must publish a privacy policy and link it in the Developer Portal. That policy must say what we collect and who we share it with.
- **Credentials:** keep the bot token and client secret confidential, and rotate them if they leak. In Whispcord the token lives **only** in discord-mcp's environment.
- **Branding:** don't imply Discord endorses Whispcord, and don't use Discord marks beyond what the brand guidelines allow. **[verify]**
- **Termination:** Discord can revoke API access. Design for the bot vanishing: servers get marked Disconnected.

## 3. Developer Policy (rules for how apps behave)

- **Consent before disclosure:** don't *"disclose any user's Discord Data without their specific, informed consent."* Whispcord sends **server structure** (channel names, role names, IDs) and the **prompt** to Anthropic. The connect flow and privacy policy must say so plainly, and the server owner agrees when connecting.
- **Message text goes to Anthropic when Message search is on.** Members' messages are other people's data, not the server owner's. The owner enables it explicitly (off by default) and the Settings text says message text is sent to Anthropic. The privacy policy must say so too, and Whispcord should tell server owners to mention it in their server rules. Only recent, bounded batches are sent, for classification only.
- **No selling or ad use of API data:** never pass API Data to *"data brokers, advertising networks"* or other monetization services.
- **AI / model training: [verify] the exact clause.** Do not use Discord API data, especially message content, to train ML/AI models. Whispcord only sends data to Claude for inference, and Anthropic's commercial API does not train on API inputs by default. Never build a training or eval dataset from customer server data. Our eval set uses our **own** test servers (build plan §7).
- **Message Content is a privileged intent, and Whispcord now uses it (Message search, opt-in per server).** Unverified apps can switch it on in the Developer Portal; past 100 servers Discord must approve it, with a justification (ours: server owners search their own server for hateful/abusive messages to moderate them). The bot only requests it when `WHISPCORD_MESSAGE_CONTENT=true`. **[verify]** the current approval criteria before applying for verification.
- **Server Members intent** is privileged. We use it for member lookups and role assignment. Past the verification threshold it needs Discord's approval, with a written justification.
- **No harmful automation:** no mass DMs, mass mentions, raids, or tools that help evade moderation or bans. This maps to Whispcord's `restricted` tier, opt-in `moderate`/`messaging` tiers, per-run limits, and human approval of every write.
- **Don't misrepresent what the app does.** Our permission request must match what we use (Builder tier, no Administrator).
- **Security:** protect user data with appropriate safeguards and report breaches. **[verify]** whether a notification deadline applies.

## 4. App verification & scale

- Unverified apps can't join more than **100 servers**. Discord lets you apply for verification from about **75 servers** **[verify current thresholds]**. Verification needs identity checks, a ToS and privacy policy URL, and justification for every privileged intent.
- **Sharding** becomes mandatory at **2,500 servers** per gateway connection. JDA supports it.

---

## Whispcord compliance checklist

Each line points to where the code enforces it. Keep these true.

| Obligation | Where it's enforced |
| --- | --- |
| Only people who can manage a server can act on it | `apps/orchestrator/src/runs/service.ts` `buildGateway()` runs a live `check_member_permissions` on every run |
| The AI can only touch the chosen server | `apps/orchestrator/src/gateway/gateway.ts`: guildId is stripped and injected, and every referenced ID is validated |
| No DMs / mass messaging | `packages/shared/src/toolTiers.ts`: DM tools are `restricted` (never enabled); `messaging` is opt-in |
| No privilege escalation; never grant Administrator | `GuildGateway.assertNoEscalation()` |
| Rate limits respected | JDA queueing + per-run caps + `MAX_RUNS_PER_SERVER_PER_HOUR` |
| Bot token kept secret | Only in discord-mcp env (`infra/docker-compose.yml`). discord-mcp has no public port and an optional shared secret (`McpSharedSecretFilter`) |
| Minimal permissions | `BUILDER_PERMISSIONS` = 27648920593, no Administrator (`packages/shared/src/permissions.ts`) |
| Server data treated as data, not instructions | `SYSTEM_PROMPT` in `apps/orchestrator/src/agent/planner.ts`; human approval of every write plan |
| Disclose what goes to Anthropic | **TODO (Phase 8):** privacy policy + ToS pages, linked in the Developer Portal and in the connect flow |
| Delete data on request / when a server leaves | `DELETE /me` (account + its servers + runs; "Delete my account" on the Servers page). `Maintenance.purge()` deletes servers disconnected longer than `DISCONNECTED_RETENTION_DAYS` (default 30) plus expired connect attempts |
| Notice when the bot is removed | Guild-leave webhook from the fork, plus `Maintenance.reconcile()` every `RECONCILE_INTERVAL_MINUTES` |
| No training on customer data | Policy: never export run logs or prompts into datasets. Evals use our own test servers only |
| Message search kept safe | Opt-in `message_search` tier; bounded scans (`scan_messages` caps per channel/total/age, `MAX_MESSAGES_SCANNED_PER_RUN`); message text goes only to a tool-less classifier (`agent/messageFinder.ts`), the planner sees IDs and reasons only; excerpts cleared after `FINDINGS_RETENTION_DAYS` (default 30) and never readable from the browser directly (migration 0004); deleting messages needs typed confirmation |
