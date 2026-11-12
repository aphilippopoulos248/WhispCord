// Starts the web app in demo mode: sample data, simulated backend, no keys needed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "--port", "3000"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_WHISPCORD_DEMO: "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
