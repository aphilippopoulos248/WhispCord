import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Supabase OAuth callback. Supabase hands us the Discord access token only here, so we use it
 * once to sync the user's manageable servers (through the orchestrator, which verifies the token
 * belongs to this user) and then forget it.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const nextParam = url.searchParams.get("next") ?? "/servers";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/servers";
  const fail = (msg: string) => NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, url.origin));

  if (!code) return fail("Discord sign-in was cancelled.");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) return fail(error?.message ?? "Sign-in failed.");

  const providerToken = data.session.provider_token;
  if (providerToken) {
    const orchestrator = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:8787";
    try {
      await fetch(`${orchestrator}/me/discord-guilds`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ providerToken }),
        cache: "no-store",
      });
    } catch {
      // Non-fatal: the server list just won't be pre-filled until the next sign-in.
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
