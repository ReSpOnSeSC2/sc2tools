"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, API_BASE } from "@/lib/clientApi";
import type {
  DevicePairingPollResp,
  DevicePairingStartResp,
} from "./types";

const POLL_INTERVAL_MS = 2000;

export interface PairCodeState {
  code: string | null;
  expiresAt: string | null;
  status: "idle" | "starting" | "waiting" | "ready" | "expired" | "error";
  error: string | null;
  /** Begin a fresh pairing handshake. */
  start: () => Promise<void>;
  /** Manually retry after error or expiry. */
  retry: () => Promise<void>;
}

/**
 * Drive the agent ↔ web pairing handshake. The signed-in user calls
 * `POST /v1/device-pairings/start` to mint a code, displays the code,
 * and polls `GET /v1/device-pairings/:code` until the agent claims it.
 *
 * NOTE: Despite the name, the SC2 Tools pairing flow is web-initiated:
 * the user signs in, the web mints the code, then they paste the code
 * into the agent. The agent posts back the claim.
 */
export function usePairCode(): PairCodeState {
  const { getToken } = useAuth();
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PairCodeState["status"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const start = useCallback(async () => {
    cancelRef.current = false;
    setStatus("starting");
    setError(null);
    setCode(null);
    setExpiresAt(null);
    try {
      const resp = await apiCall<DevicePairingStartResp>(
        getToken,
        "/v1/device-pairings/start",
        { method: "POST", body: "{}" },
      );
      if (cancelRef.current) return;
      setCode(resp.code);
      setExpiresAt(resp.expiresAt);
      setStatus("waiting");
    } catch (err: unknown) {
      if (cancelRef.current) return;
      setStatus("error");
      setError(messageFor(err));
    }
  }, [getToken]);

  // Poll the public endpoint while waiting for the agent to claim.
  // We poll the API directly (no JWT) — the code is the secret.
  useEffect(() => {
    if (status !== "waiting" || !code) return;

    let cancelled = false;
    let timer: number | null = null;

    async function pollOnce() {
      try {
        const res = await fetch(
          `${API_BASE}/v1/device-pairings/${encodeURIComponent(code as string)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        const body: DevicePairingPollResp = await res.json().catch(() => ({
          status: "pending" as const,
        }));
        if (body.status === "ready") {
          setStatus("ready");
          return;
        }
        if (body.status === "expired") {
          setStatus("expired");
          return;
        }
        timer = window.setTimeout(pollOnce, POLL_INTERVAL_MS);
      } catch {
        if (cancelled) return;
        // Transient network — keep polling so the user doesn't lose
        // progress on a flaky connection.
        timer = window.setTimeout(pollOnce, POLL_INTERVAL_MS);
      }
    }

    timer = window.setTimeout(pollOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [status, code]);

  // Cancel inflight start() if the consumer unmounts.
  useEffect(() => {
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const retry = useCallback(async () => {
    await start();
  }, [start]);

  return { code, expiresAt, status, error, start, retry };
}

function messageFor(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  if (err instanceof Error) return err.message;
  return "Couldn't start pairing — try again.";
}
