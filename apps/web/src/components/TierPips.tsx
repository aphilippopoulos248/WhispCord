import type { Tier } from "@whispcord/shared";

/** The permissions a server owner can switch on, in deck order, with their light colour. */
export const DECK_TIERS: Array<{ tier: Tier; short: string; color: string }> = [
  { tier: "build", short: "BUILD", color: "var(--color-accent)" },
  { tier: "destructive", short: "DELETE", color: "var(--color-danger)" },
  { tier: "moderate", short: "MODERATE", color: "var(--color-ok)" },
  { tier: "messaging", short: "MESSAGE", color: "var(--color-warn)" },
  { tier: "message_search", short: "SEARCH", color: "var(--color-phosphor)" },
  { tier: "live_watch", short: "WATCH", color: "var(--color-watch)" },
];

/** A row of small bars, one per permission, lit when that permission is on. */
export function TierPips({ tiers }: { tiers: Tier[] }) {
  return (
    <span className="flex gap-[3px]" aria-label={`Allowed: ${DECK_TIERS.filter((t) => tiers.includes(t.tier)).map((t) => t.short.toLowerCase()).join(", ") || "read only"}`}>
      {DECK_TIERS.map((t) => (
        <span key={t.tier} className="tier-pip" style={tiers.includes(t.tier) ? { background: t.color } : undefined} />
      ))}
    </span>
  );
}
