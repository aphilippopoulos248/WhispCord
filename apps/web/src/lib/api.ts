"use client";

import type { RunEvent, WatchEvent } from "@whispcord/shared";
import { demoApi, demoSubscribe } from "./demoApi";
import { demoSubscribeWatch } from "./demoWatch";
import { isDemo } from "./demoData";
import { createClient } from "./supabase/client";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:8787";

async function token(): Promise<string> {
  const { data } = await createClient().auth.getSession();
  if (!data.session) throw new Error("Your session expired. Sign in again.");
  return data.session.access_token;
}

/** Calls the Whispcord orchestrator with the user's Supabase session. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (isDemo) return demoApi<T>(path, init);
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/**
 * Subscribes to a run's live events. Uses fetch streaming because EventSource can't send an
 * Authorization header. Returns an unsubscribe function.
 */
export function subscribeRun(runId: string, onEvent: (e: RunEvent) => void): () => void {
  if (isDemo) return demoSubscribe(runId, onEvent);
  return stream<RunEvent>(`/runs/${runId}/events`, onEvent);
}

/** Live-watch flags for a server as they arrive. Returns an unsubscribe function. */
export function subscribeWatch(guildId: string, onEvent: (e: WatchEvent) => void): () => void {
  if (isDemo) return demoSubscribeWatch(guildId, onEvent);
  return stream<WatchEvent>(`/servers/${guildId}/watch/events`, onEvent);
}

function stream<E>(path: string, onEvent: (e: E) => void): () => void {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${await token()}` },
        signal: controller.signal,
      });
      if (!res.body) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                onEvent(JSON.parse(line.slice(6)) as E);
              } catch {
                /* ignore malformed */
              }
            }
          }
        }
      }
    } catch {
      /* aborted or network error; the UI refetches state */
    }
  })();
  return () => controller.abort();
}
