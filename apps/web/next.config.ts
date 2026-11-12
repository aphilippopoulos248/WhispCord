import path from "node:path";
import type { NextConfig } from "next";

// Node 22.12+: Supabase's client crashes on Node 20 ("native WebSocket not found"), and the
// Tailwind build needs require() of ES modules, on by default only from 22.12.
// (Demo mode never creates a Supabase client, so `next dev` in demo mode still runs on Node 20.)
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number) as [number, number];
if ((nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) && process.env.NEXT_PUBLIC_WHISPCORD_DEMO !== "1") {
  throw new Error(`Whispcord needs Node.js 22.12 or newer (found ${process.versions.node}). Run: nvm install 22, then nvm use it.`)
}

// Local development keeps every setting in the repo-root .env (one file for the whole stack).
// Next only reads env files from apps/web, so load the root one too. Variables that are already
// set (real environment, or apps/web/.env*) are not overridden.
// Note: @next/env's loadEnvConfig can't be used for this: it caches the first directory Next
// loaded (apps/web) and silently ignores a second call for another folder.
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  // No root .env (e.g. production, where the host provides env vars). That's fine.
}

// Values loaded above only reach this config process. Next builds the proxy (src/proxy.ts) and
// the browser bundles separately, so pass the browser-safe NEXT_PUBLIC_* values through `env`,
// which Next inlines everywhere. Never add server secrets here: `env` values ship to the browser.
const publicEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k, v]) => k.startsWith("NEXT_PUBLIC_") && v !== undefined && v !== ""),
) as Record<string, string>;

const nextConfig: NextConfig = {
  // The shared workspace package ships TypeScript source.
  transpilePackages: ["@whispcord/shared"],
  env: publicEnv,
};

export default nextConfig;
