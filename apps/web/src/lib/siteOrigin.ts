import type { NextRequest } from "next/server";

/**
 * The public origin to build redirects from. Behind a proxy (Railway, Docker) `request.nextUrl`
 * carries the container's bind address (e.g. https://0.0.0.0:3000), which browsers can't open.
 * Prefer the configured site URL, then the proxy's forwarded host, then the request itself.
 */
export function siteOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}
