"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { isDemo } from "@/lib/demoData";
import { createClient } from "@/lib/supabase/client";

function LoginInner() {
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));

  async function signIn() {
    setBusy(true);
    setError(null);
    if (isDemo) {
      window.location.href = "/servers";
      return;
    }
    const next = params.get("next") ?? "/servers";
    const site = process.env.NEXT_PUBLIC_SITE_URL ?? window.location.origin;
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "discord",
      options: {
        scopes: "identify guilds",
        redirectTo: `${site}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-24">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Sign in to Whispcord</h1>
        <p className="mt-2 text-sm text-muted">
          We ask Discord for your username and the list of servers you’re in, so we can show the ones you manage.
        </p>
        <button className="btn-primary mt-6 w-full" onClick={signIn} disabled={busy}>
          {busy ? "Opening Discord…" : "Continue with Discord"}
        </button>
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
