"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

/** Discord redirects here after the user authorizes the bot. */
function ConnectCallbackInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const state = params.get("state");
    const guildId = params.get("guild_id");
    const discordError = params.get("error_description") ?? params.get("error");
    if (discordError) {
      setError(`Discord says: ${discordError}`);
      return;
    }
    if (!state || !guildId) {
      setError("This link is missing information from Discord. Start the connection again.");
      return;
    }
    api<{ server: { guildId: string } }>("/connect/complete", { body: { state, guildId } })
      .then(({ server }) => router.replace(`/servers/${server.guildId}?connected=1`))
      .catch((e: Error) => setError(e.message));
  }, [params, router]);

  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      {error ? (
        <div className="card p-6">
          <h1 className="text-lg font-semibold">Couldn’t connect the server</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <Link href="/servers" className="btn-ghost mt-6">Back to servers</Link>
        </div>
      ) : (
        <p className="text-muted">Checking that Whispcord joined your server…</p>
      )}
    </div>
  );
}

export default function ConnectCallbackPage() {
  return (
    <Suspense>
      <ConnectCallbackInner />
    </Suspense>
  );
}
