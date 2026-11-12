import path from "node:path";
import type { NextConfig } from "next";

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
