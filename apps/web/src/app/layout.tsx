import type { Metadata } from "next";
import Link from "next/link";
import { isDemo } from "@/lib/demoData";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Whispcord",
  description: "Manage your Discord server in plain English.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = isDemo ? { id: "demo-user" } : (await (await createClient()).auth.getUser()).data.user;
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        {isDemo && (
          <div className="bg-accent/15 px-4 py-1.5 text-center text-xs text-accent">
            Demo mode: sample data and a simulated backend. Nothing touches Discord.
          </div>
        )}
        <header className="border-b border-line">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="inline-block h-6 w-6 rounded-md bg-accent" aria-hidden />
              Whispcord
            </Link>
            <nav className="flex items-center gap-3 text-sm">
              {user ? (
                <>
                  <Link href="/servers" className="text-muted hover:text-text">Servers</Link>
                  {!isDemo && (
                    <form action="/auth/signout" method="post">
                      <button className="text-muted hover:text-text">Sign out</button>
                    </form>
                  )}
                </>
              ) : (
                <Link href="/login" className="btn-primary">Sign in</Link>
              )}
            </nav>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
