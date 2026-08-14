// YouTube chat engine — drives the API's stateless resolve/poll relay.
//
// The Browser Source owns the polling loop (the API retains only a tiny
// bounded in-flight/result cache):
// resolve the streamer's channel to a live continuation once, then
// poll at the cadence YouTube itself requests. A finished stream
// re-resolves on a slow timer so the widget picks the next stream up
// automatically.

import { isChatEventKind } from "./events";
import type { ChatEngine, EngineCallbacks } from "./types";

/** Re-resolve cadence while the channel is offline / stream ended. */
const OFFLINE_RETRY_MS = 60_000;
/** Backoff after transient poll failures. */
const ERROR_RETRY_MS = 10_000;

interface WireMessage {
  id: string;
  user: string;
  text: string;
  badges: string[];
  atMs: number;
}

interface WireEvent {
  id: string;
  kind: string;
  user: string;
  detail: string;
  amount?: string;
  atMs: number;
}

interface PollResponse {
  messages: WireMessage[];
  /** Absent on older API builds — treat as empty. */
  events?: WireEvent[];
  continuation: string | null;
  timeoutMs: number;
  done: boolean;
}

export function createYoutubeChat(
  opts: {
    apiBase: string;
    token: string;
    channel: string;
    callbacks: EngineCallbacks;
  },
): ChatEngine {
  const { apiBase, token, channel, callbacks } = opts;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();

  const schedule = (fn: () => void, ms: number) => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };

  const base = `${apiBase}/v1/multichat/${encodeURIComponent(token)}`;

  const resolve = async () => {
    if (closed) return;
    callbacks.onStatus("connecting");
    try {
      const res = await fetch(
        `${base}/youtube/resolve?channel=${encodeURIComponent(channel)}`,
        { signal: controller.signal, cache: "no-store" },
      );
      if (res.status === 503) {
        callbacks.onStatus("connecting");
        schedule(
          resolve,
          retryAfterMs(res.headers.get("retry-after"), ERROR_RETRY_MS),
        );
        return;
      }
      if (res.status === 502) {
        const body = await res.json().catch(() => null);
        const code = body?.error?.code;
        callbacks.onStatus(
          code === "not_live" ? "offline" : "error",
          code === "not_live" ? undefined : String(code || "upstream"),
        );
        schedule(resolve, OFFLINE_RETRY_MS);
        return;
      }
      if (!res.ok) {
        callbacks.onStatus("error", `resolve ${res.status}`);
        schedule(resolve, OFFLINE_RETRY_MS);
        return;
      }
      const data = (await res.json()) as {
        continuation: string;
        clientVersion: string;
      };
      callbacks.onStatus("connected");
      void poll(data.continuation, data.clientVersion, true);
    } catch (err) {
      if (closed) return;
      callbacks.onStatus("error", String(err).slice(0, 80));
      schedule(resolve, ERROR_RETRY_MS);
    }
  };

  const poll = async (
    continuation: string,
    clientVersion: string,
    firstPoll: boolean,
  ) => {
    if (closed) return;
    try {
      const res = await fetch(`${base}/youtube/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuation, clientVersion }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (res.status === 503) {
        callbacks.onStatus("connecting");
        schedule(
          () => void poll(continuation, clientVersion, firstPoll),
          retryAfterMs(res.headers.get("retry-after"), ERROR_RETRY_MS),
        );
        return;
      }
      if (!res.ok) {
        callbacks.onStatus("error", `poll ${res.status}`);
        schedule(resolve, ERROR_RETRY_MS);
        return;
      }
      const data = (await res.json()) as PollResponse;
      // The resolve continuation replays recent history; skip that
      // first batch so switching scenes doesn't dump stale lines.
      if (!firstPoll) {
        for (const m of data.messages) {
          callbacks.onMessage({
            platform: "youtube",
            id: m.id,
            user: m.user,
            text: m.text,
            badges: (m.badges || []).filter(
              (b): b is "owner" | "moderator" | "member" | "verified" =>
                ["owner", "moderator", "member", "verified"].includes(b),
            ),
            atMs: m.atMs,
          });
        }
        for (const e of data.events || []) {
          if (!isChatEventKind(e.kind)) continue;
          callbacks.onEvent?.({
            platform: "youtube",
            id: e.id,
            kind: e.kind,
            user: e.user,
            detail: e.detail,
            amount: e.amount,
            atMs: e.atMs,
          });
        }
      }
      if (data.done || !data.continuation) {
        callbacks.onStatus("ended");
        schedule(resolve, OFFLINE_RETRY_MS);
        return;
      }
      schedule(
        () => void poll(data.continuation as string, clientVersion, false),
        data.timeoutMs,
      );
    } catch (err) {
      if (closed) return;
      callbacks.onStatus("error", String(err).slice(0, 80));
      schedule(resolve, ERROR_RETRY_MS);
    }
  };

  void resolve();

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      controller.abort();
    },
  };
}

/**
 * Clamp server backpressure so old/malformed proxies cannot cause a hot loop
 * or leave an OBS Browser Source dormant for minutes.
 */
export function retryAfterMs(
  header: string | null,
  fallbackMs: number,
): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.max(1_000, Math.min(30_000, Math.round(seconds * 1_000)));
}
