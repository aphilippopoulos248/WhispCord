"use client";

import { isSnowflake } from "@whispcord/shared";
import { useState } from "react";
import { api } from "@/lib/api";
import { ServerIcon } from "./ServerIcon";

interface Guild {
  id: string;
  name: string;
  icon: string | null;
}

export function ConnectServer({ manageable }: { manageable: Guild[] }) {
  const [guildId, setGuildId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  async function connect(id: string) {
    setError(null);
    if (!isSnowflake(id)) {
      setError("Server IDs are 17–20 digit numbers.");
      return;
    }
    setBusy(true);
    try {
      const { authorizeUrl } = await api<{ authorizeUrl: string }>("/connect/start", { body: { guildId: id } });
      window.location.href = authorizeUrl;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 grid gap-4">
      {manageable.length > 0 && (
        <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {manageable.map((g) => (
            <li key={g.id} className="empty-slot flex items-center gap-3 p-3">
              <ServerIcon name={g.name} icon={g.icon} size={32} />
              <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
              <button className="btn-primary" disabled={busy} onClick={() => connect(g.id)}>
                Connect
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="well p-4">
        <label htmlFor="guildId" className="label-caps">Or paste a server ID</label>
        <div className="mt-2 flex flex-wrap gap-2 sm:flex-nowrap">
          <input
            id="guildId"
            className="input font-mono"
            inputMode="numeric"
            placeholder="e.g. 123456789012345678"
            value={guildId}
            onChange={(e) => setGuildId(e.target.value.trim())}
          />
          <button className="btn-primary shrink-0" disabled={busy || !guildId} onClick={() => connect(guildId)}>
            {busy ? "Opening Discord…" : "Add Whispcord to server"}
          </button>
        </div>
        <button className="mt-2 text-xs text-muted underline" onClick={() => setShowHelp((v) => !v)}>
          How do I find my server ID?
        </button>
        {showHelp && (
          <ol className="mt-2 list-decimal pl-5 text-xs text-muted">
            <li>In Discord, open User Settings → Advanced and turn on Developer Mode.</li>
            <li>Right-click your server icon and choose Copy Server ID.</li>
          </ol>
        )}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}
