/** Connection state shown as a status light: green ready, blinking amber bot role too low, red disconnected. */
export function serverState(status: string, roleOk: boolean) {
  if (status !== "connected") return { led: "led-off", tone: "text-danger", short: "OFFLINE", label: "Disconnected" };
  if (!roleOk) return { led: "led-warn", tone: "text-warn", short: "ROLE TOO LOW", label: "Bot role too low" };
  return { led: "led-ok", tone: "text-ok", short: "ONLINE", label: "Connected" };
}

export function StatusPill({ status, roleOk }: { status: string; roleOk: boolean }) {
  const s = serverState(status, roleOk);
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-well px-2.5 py-1.5 font-mono text-[10.5px] font-bold tracking-[0.12em]">
      <span className={`led ${s.led}`} aria-hidden />
      <span className={s.tone}>{s.short}</span>
      <span className="sr-only">{s.label}</span>
    </span>
  );
}

export function StatusDot({ status, roleOk }: { status: string; roleOk: boolean }) {
  const s = serverState(status, roleOk);
  return <span className={`led ${s.led}`} role="img" aria-label={s.label} />;
}
