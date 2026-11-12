/* eslint-disable @next/next/no-img-element */
export function ServerIcon({ name, icon, size = 40 }: { name: string; icon: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return icon ? (
    <img src={icon} alt="" width={size} height={size} className="shrink-0 rounded-[10px] border border-[#343b49]" />
  ) : (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] border border-[#343b49] bg-well font-display text-xs font-extrabold text-muted"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}
