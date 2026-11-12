import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { isDemo } from "@/lib/demoData";
import { createClient } from "@/lib/supabase/server";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap", weight: ["600", "800"] });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap", weight: ["500", "700"] });

export const metadata: Metadata = {
  title: "Whispcord",
  description: "Manage your Discord server in plain English.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = isDemo ? { id: "demo-user" } : (await (await createClient()).auth.getUser()).data.user;
  return (
    <html lang="en" className={`${inter.variable} ${bricolage.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen font-sans text-sm antialiased">
        {isDemo && (
          <div className="border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-center font-mono text-[11px] tracking-wide text-warn">
            DEMO MODE · sample data and a simulated backend. Nothing touches Discord.
          </div>
        )}
        <header>
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4">
            <Link href="/" className="flex items-center gap-2.5 font-display text-xl font-extrabold tracking-tight">
              <span
                className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-base text-ink shadow-[0_0_18px_rgb(139_124_246/0.5)]"
                aria-hidden
              >
                W
              </span>
              Whispcord
            </Link>
            <nav className="flex items-center gap-3">
              {user ? (
                <>
                  <Link href="/servers" className="btn">All servers</Link>
                  {!isDemo && (
                    <form action="/auth/signout" method="post">
                      <button className="btn-ghost">Sign out</button>
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
