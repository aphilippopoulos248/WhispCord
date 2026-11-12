export function StatusPill({ status, roleOk }: { status: string; roleOk: boolean }) {
  const [label, cls] =
    status !== "connected"
      ? ["Disconnected", "bg-danger/15 text-danger"]
      : !roleOk
        ? ["Bot role too low", "bg-warn/15 text-warn"]
        : ["Connected", "bg-ok/15 text-ok"];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${cls}`}>{label}</span>;
}

export function StatusDot({ status, roleOk }: { status: string; roleOk: boolean }) {
  const cls = status !== "connected" ? "bg-danger" : !roleOk ? "bg-warn" : "bg-ok";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} aria-hidden />;
}
