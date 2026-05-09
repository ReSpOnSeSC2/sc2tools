"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE } from "@/lib/clientApi";
import type { LiveGameEnvelope } from "@/components/overlay/types";

/**
 * Live-game state surfaced to the dashboard from the cloud's
 * ``GET /v1/me/live`` SSE endpoint.
 *
 * ``live`` carries the most recent ``LiveGameEnvelope`` the broker
 * fanned out for this user; ``lastUpdatedAt`` is the wall-clock ms
 * stamp of the most recent successful read so the panel can fade out
 * when the agent has stopped emitting.
 */
export interface LiveGameState {
  live: LiveGameEnvelope | null;
  lastUpdatedAt: number | null;
  /** True while the SSE connection is established. */
  connected: boolean;
}

/**
 * SSE reader for the per-user live envelope stream.
 *
 * Native ``EventSource`` cannot attach an Authorization header, and
 * the ``GET /v1/me/live`` route is Clerk-authed via Bearer token.
 * We use ``fetch`` with a ReadableStream reader instead — same SSE
 * semantics, just driven by the cooperative loop below.
 *
 * Connection lifecycle:
 *
 *   1. ``useAuth`` resolves → fetch the stream with the Clerk JWT.
 *   2. While the response body is open, parse ``data: ...\n\n``
 *      events and push each parsed envelope into state.
 *   3. On close (server tear-down, network blip, navigation away),
 *      back off and reconnect — capped at one attempt every 10 s
 *      so a sustained outage doesn't saturate the API.
 *   4. On unmount: abort the fetch, signal the reader to stop, and
 *      clear any pending reconnect timer so the hook tears down
 *      cleanly even mid-flight.
 *
 * Idle envelopes (``phase: "idle"`` / ``"menu"``) clear ``live`` so
 * the dashboard panel hides instead of pinning the previous game's
 * data.
 */
export function useLiveGame(): LiveGameState {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [state, setState] = useState<LiveGameState>({
    live: null,
    lastUpdatedAt: null,
    connected: false,
  });
  // Re-create the connection whenever the Clerk session resolves; the
  // ref+effect dance below makes sure unmount + auth changes both
  // tear down the previous fetch.
  const abortRef = useRef<AbortController | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const cancelledRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    cancelledRef.current = false;
    let attempt = 0;

    const cleanupTimer = () => {
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelledRef.current) return;
      // Exponential-ish back-off, capped — the cloud is single-instance
      // today; mashing reconnect during a real outage is anti-social.
      const delay = Math.min(10_000, 500 * Math.pow(2, attempt));
      attempt += 1;
      cleanupTimer();
      reconnectRef.current = window.setTimeout(() => {
        reconnectRef.current = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelledRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let token: string | null = null;
      try {
        token = await getToken();
      } catch {
        // Token fetch failed (Clerk session lost). Reconnect path will
        // try again — we don't try to drive the user through a sign-in
        // flow from here.
        scheduleReconnect();
        return;
      }
      if (cancelledRef.current) return;
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/v1/me/live`, {
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
          signal: ctrl.signal,
          cache: "no-store",
        });
      } catch (err) {
        if (cancelledRef.current) return;
        if (isAbortError(err)) return;
        scheduleReconnect();
        return;
      }
      if (!res.ok || !res.body) {
        scheduleReconnect();
        return;
      }
      // Mark connected on the FIRST byte (we'll get the ": ok\n\n"
      // hello immediately) — reset back-off so subsequent transient
      // closes don't keep doubling the delay.
      attempt = 0;
      setState((prev) => ({ ...prev, connected: true }));
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      try {
        for (;;) {
          if (cancelledRef.current) {
            reader.cancel().catch(() => {});
            return;
          }
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE event delimiter is a blank line. Split-and-keep the
          // residual partial frame for the next iteration.
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const env = parseSseFrame(frame);
            if (env !== undefined) {
              if (
                env === null
                || env.phase === "idle"
                || env.phase === "menu"
              ) {
                setState({
                  live: null,
                  lastUpdatedAt: Date.now(),
                  connected: true,
                });
              } else {
                setState({
                  live: env,
                  lastUpdatedAt: Date.now(),
                  connected: true,
                });
              }
            }
          }
        }
      } catch (err) {
        if (cancelledRef.current) return;
        if (!isAbortError(err)) {
          // Stream errored mid-read — fall through to reconnect.
        }
      }
      if (!cancelledRef.current) {
        setState((prev) => ({ ...prev, connected: false }));
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      cancelledRef.current = true;
      cleanupTimer();
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // best-effort
        }
        abortRef.current = null;
      }
    };
  }, [isLoaded, isSignedIn, getToken]);

  return state;
}

/**
 * Parse one SSE ``data: ...`` frame. Comment lines (``: heartbeat``)
 * and the initial ``: ok`` hello are returned as ``undefined`` so the
 * caller can ignore them; ``data:`` lines that fail to JSON-parse are
 * also returned as ``undefined`` (the next frame will likely succeed).
 *
 * Returning ``null`` is reserved for envelopes the consumer should
 * treat as "clear" (currently unused — the consumer normalises
 * idle/menu envelopes itself).
 */
function parseSseFrame(frame: string): LiveGameEnvelope | null | undefined {
  const lines = frame.split(/\r?\n/);
  let dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      // SSE allows the leading-space convention; trim a single space if present.
      const piece = line.slice(5);
      dataLines.push(piece.startsWith(" ") ? piece.slice(1) : piece);
    }
  }
  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LiveGameEnvelope;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ERR_ABORTED";
}
