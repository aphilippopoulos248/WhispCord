/* eslint-disable @next/next/no-img-element */
export function ServerIcon({ name, icon, size = 40 }: { name: string; icon: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return icon ? (
    <img src={icon} alt="" width={size} height={size} className="rounded-xl" />
  ) : (
    <span
      className="inline-flex items-center justify-center rounded-xl bg-panel-2 text-xs font-semibold text-muted"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}
