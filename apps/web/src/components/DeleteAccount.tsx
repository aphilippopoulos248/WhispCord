"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { isDemo } from "@/lib/demoData";

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    setBusy(true);
    setError(null);
    try {
      await api("/me", { method: "DELETE" });
      if (!isDemo) await createClient().auth.signOut();
      window.location.href = "/";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="mt-2 text-sm text-danger underline" onClick={() => setOpen(true)}>
        Delete my Whispcord account
      </button>
    );
  }
  return (
    <div className="card mt-3 border-danger/40 p-4 text-sm">
      <p>
        This permanently deletes your account, every server you connected and their run history. The bot stays in your
        servers until you remove it in Discord.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className="input max-w-48" placeholder="Type DELETE" value={typed} onChange={(e) => setTyped(e.target.value)} />
        <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn-danger" disabled={busy || typed !== "DELETE"} onClick={del}>Delete everything</button>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}
    </div>
  );
}
