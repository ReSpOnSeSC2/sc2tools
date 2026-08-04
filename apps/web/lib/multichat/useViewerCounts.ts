"use client";

// useViewerCounts — live audience size for the Stream Dock: how many
// people each configured platform is showing right now, plus the
// combined total across all of them.
//
// The numbers come from /v1/multichat/:token/viewers, which reads
// them off the platforms themselves (the browser can't: none of the
// four send CORS headers). Same boot-fetch + slow-refetch shape as
// useEngagementState, with one addition — a hidden tab stops polling
// and refetches the moment it comes back, so a dock parked behind an
// OBS tab all stream doesn't keep four upstreams warm for nobody.
//
// A count of `null` means UNKNOWN, not zero: the platform was
// unreachable (Kick's Cloudflare block, a transient upstream error)
// or, for TikTok, nothing is holding the webcast connection open.
// Consumers render nothing for those — a fake 0 is worse than a gap.

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { CHAT_PLATFORMS, type ChatPlatform } from "./types";

/** Poll cadence — viewer counts move slowly; the server caches ~20s. */
const REFRESH_MS = 45_000;

export interface PlatformViewers {
  platform: ChatPlatform;
  /** Live viewers, or null when the count is unknown. */
  viewers: number | null;
  live: boolean;
}

export interface ViewerCounts {
  platforms: PlatformViewers[];
  /** Sum of the KNOWN per-platform counts. */
  total: number;
  /** True when at least one configured platform reported unknown. */
  partial: boolean;
  /** False until the first successful response — the UI stays blank. */
  loaded: boolean;
}

export const EMPTY_VIEWER_COUNTS: ViewerCounts = {
  platforms: [],
  total: 0,
  partial: false,
  loaded: false,
};

function isPlatform(v: unknown): v is ChatPlatform {
  return CHAT_PLATFORMS.includes(v as ChatPlatform);
}

/** Wire → typed, dropping anything that isn't a real count. */
export function sanitizeViewerCounts(raw: unknown): ViewerCounts {
  if (!raw || typeof raw !== "object") return { ...EMPTY_VIEWER_COUNTS, loaded: true };
  const body = raw as Record<string, unknown>;
  const seen = new Set<ChatPlatform>();
  const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
    .map((p) => {
      const e = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      if (!isPlatform(e.platform) || seen.has(e.platform)) return null;
      seen.add(e.platform);
      const n = Number(e.viewers);
      const viewers =
        e.viewers === null || !Number.isFinite(n) || n < 0
          ? null
          : Math.floor(n);
      return { platform: e.platform, viewers, live: Boolean(e.live) };
    })
    .filter((p): p is PlatformViewers => p !== null);

  // Recompute the total from what survived sanitizing rather than
  // trusting the wire's number — they can only disagree if something
  // upstream is wrong, and the visible sum should match the parts.
  let total = 0;
  let partial = false;
  for (const p of platforms) {
    if (p.viewers === null) partial = true;
    else total += p.viewers;
  }
  return { platforms, total, partial, loaded: true };
}

/**
 * Format a viewer count for a dock-width strip: exact below 10k,
 * one-decimal compact above (12.3K, 1.2M) so the number never
 * reflows the header on a busy stream.
 */
export function formatViewers(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${trim1(n / 1_000)}K`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Live viewer counts for one overlay token. */
export function useViewerCounts(token: string): ViewerCounts {
  const [counts, setCounts] = useState<ViewerCounts>(EMPTY_VIEWER_COUNTS);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/viewers`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const body: unknown = await res.json();
        if (cancelled) return;
        setCounts(sanitizeViewerCounts(body));
      } catch {
        // Transient — keep showing the last good numbers and retry on
        // the next tick rather than blanking a working strip.
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  return counts;
}
