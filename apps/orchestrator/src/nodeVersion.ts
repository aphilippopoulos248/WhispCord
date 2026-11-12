/**
 * Whispcord needs Node.js 22.12+:
 * - Supabase's client crashes on older Node ("native WebSocket not found" on Node 20);
 * - Tailwind's build and Fastify's test helper require() ES modules, which Node enables by
 *   default only from 22.12 (22.11 fails with "require() of ES Module ... not supported").
 * Fail early with a message that says what to do. Imported first by the entry points.
 */
const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `Whispcord needs Node.js 22.12 or newer (found ${process.versions.node}).
` +
      "  With nvm for Windows: nvm install 22, then nvm use <the version it installed>",
  );
  process.exit(1);
}
export {};
