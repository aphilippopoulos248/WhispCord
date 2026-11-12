import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle the workspace package (it ships TypeScript source).
  noExternal: ["@whispcord/shared"],
});
