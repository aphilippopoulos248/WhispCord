/**
 * Downloads image attachments for the live-watch classifier.
 *
 * The URLs arrive from discord-mcp, but they still point at member uploads, so:
 *   - only https links on Discord's own CDN hosts are fetched (no redirects), so a forged event
 *     can't make the orchestrator request internal or arbitrary addresses;
 *   - only JPEG, PNG, GIF and WebP, checked against the response, not just the claimed type;
 *   - at most 5 MB (Anthropic's per-image limit), enforced while reading, with a timeout.
 * Images are held in memory for one classifier call and never stored.
 */

export const IMAGE_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export interface FetchedImage {
  mediaType: ImageMediaType;
  /** base64 */
  data: string;
  bytes: number;
}

export type ImageFetcher = (url: string) => Promise<FetchedImage | null>;

export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && IMAGE_HOSTS.has(u.hostname) && (u.port === "" || u.port === "443") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Fetches one image, or returns null if it isn't allowed, is too big, or fails. */
export function makeImageFetcher(fetchImpl: typeof fetch = fetch): ImageFetcher {
  return async (url) => {
    if (!isAllowedImageUrl(url)) return null;
    try {
      const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok || !res.body) return null;
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.has(type)) return null;
      if (Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return null;

      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      const sniffed = sniffImageType(buf);
      if (!sniffed) return null;
      return { mediaType: sniffed, data: buf.toString("base64"), bytes: total };
    } catch {
      return null;
    }
  };
}

/** The real type from the file's first bytes, so a mislabelled file is never sent as an image. */
export function sniffImageType(b: Uint8Array): ImageMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
