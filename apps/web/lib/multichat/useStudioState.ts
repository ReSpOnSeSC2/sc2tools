"use client";

// useStudioState — client mirror of the server's multichat "stream
// studio" state (highlight pin, chat poll, stream goals, blocklist,
// recap trigger). One state blob per overlay TOKEN, served by
// GET /v1/multichat/:token/studio and pushed live over the overlay
// socket as ``overlay:multichat`` with the SAME shape.
//
// The hook fetches on mount, refetches on a slow cadence as a
// missed-event fallback, and applies every socket payload the caller
// hands it. Everything crossing the wire is re-sanitized here — the
// widgets must render safely even if a hostile payload reaches the
// socket room.

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { CHAT_PLATFORMS, type ChatPlatform } from "./types";

/** Fallback refetch cadence — socket pushes are the fast path. */
const STUDIO_REFRESH_MS = 60_000;

export interface StudioHighlight {
  platform: ChatPlatform;
  user: string;
  text: string;
  atMs: number;
}

export interface StudioPoll {
  question: string;
  options: string[];
  startedAtMs: number;
  status: "open" | "closed";
  /** Build votes carry the candidates' real win-rates. */
  meta?: { kind: "build"; winRates: Record<string, number> };
}

export interface StudioGoal {
  label: string;
  current: number;
  target: number;
}

export interface StudioScene {
  mode: "brb" | "starting";
  message: string;
  /** Epoch ms the countdown targets, or null for no countdown. */
  countdownEndsAt: number | null;
  /** Epoch ms the scene was set — lets widgets show elapsed time. */
  setAtMs: number;
}

export interface StudioTimer {
  label: string;
  endsAt: number;
  setAtMs: number;
}

export interface StudioState {
  highlight: StudioHighlight | null;
  poll: StudioPoll | null;
  goals: StudioGoal[];
  blockedUsers: string[];
  recapSeq: number;
  scene: StudioScene | null;
  timer: StudioTimer | null;
  /** Epoch ms the streamer marked as go-live — clip-log VOD offsets. */
  streamStartMs: number | null;
  /** VOD URL for clickable clip-moment timestamps (https, validated). */
  vodUrl: string | null;
  updatedAt: string | null;
}

export const DEFAULT_STUDIO_STATE: StudioState = {
  highlight: null,
  poll: null,
  goals: [],
  blockedUsers: [],
  recapSeq: 0,
  scene: null,
  timer: null,
  streamStartMs: null,
  vodUrl: null,
  updatedAt: null,
};

function isPlatform(value: unknown): value is ChatPlatform {
  return CHAT_PLATFORMS.includes(value as ChatPlatform);
}

function sanitizeHighlight(raw: unknown): StudioHighlight | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const user = typeof h.user === "string" ? h.user.trim() : "";
  const text = typeof h.text === "string" ? h.text.trim() : "";
  if (!user || !text) return null;
  return {
    platform: isPlatform(h.platform) ? h.platform : "twitch",
    user,
    text,
    atMs: Number.isFinite(Number(h.atMs)) ? Number(h.atMs) : 0,
  };
}

function sanitizePoll(raw: unknown): StudioPoll | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const question = typeof p.question === "string" ? p.question.trim() : "";
  const options = (Array.isArray(p.options) ? p.options : [])
    .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    .map((o) => o.trim());
  if (!question || options.length < 2) return null;
  const out: StudioPoll = {
    question,
    options,
    startedAtMs: Number.isFinite(Number(p.startedAtMs))
      ? Number(p.startedAtMs)
      : 0,
    status: p.status === "closed" ? "closed" : "open",
  };
  const meta = p.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object" && meta.kind === "build") {
    const winRates: Record<string, number> = {};
    const rawRates = (meta.winRates ?? {}) as Record<string, unknown>;
    for (const name of options) {
      const v = Number(rawRates[name]);
      if (Number.isFinite(v)) winRates[name] = Math.min(100, Math.max(0, Math.round(v)));
    }
    out.meta = { kind: "build", winRates };
  }
  return out;
}

function sanitizeGoals(raw: unknown): StudioGoal[] {
  if (!Array.isArray(raw)) return [];
  const out: StudioGoal[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const goal = g as Record<string, unknown>;
    const label = typeof goal.label === "string" ? goal.label.trim() : "";
    if (!label) continue;
    out.push({
      label,
      current: Math.max(0, Math.round(Number(goal.current) || 0)),
      target: Math.max(1, Math.round(Number(goal.target) || 1)),
    });
  }
  return out;
}

function sanitizeScene(raw: unknown): StudioScene | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.mode !== "brb" && s.mode !== "starting") return null;
  const ends = Number(s.countdownEndsAt);
  return {
    mode: s.mode,
    message: typeof s.message === "string" ? s.message.slice(0, 80) : "",
    countdownEndsAt: Number.isFinite(ends) && ends > 0 ? ends : null,
    setAtMs: Number.isFinite(Number(s.setAtMs)) ? Number(s.setAtMs) : 0,
  };
}

function sanitizeTimer(raw: unknown): StudioTimer | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const ends = Number(t.endsAt);
  if (!Number.isFinite(ends) || ends <= 0) return null;
  return {
    label: typeof t.label === "string" ? t.label.slice(0, 40) : "",
    endsAt: ends,
    setAtMs: Number.isFinite(Number(t.setAtMs)) ? Number(t.setAtMs) : 0,
  };
}

/**
 * Narrow an untrusted wire value (GET body or socket payload) to a
 * fully-defaulted StudioState. Never throws.
 */
/** Client mirror of the server's VOD-URL rule: https only, parseable. */
function sanitizeVodUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 300);
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeStudioState(raw: unknown): StudioState {
  if (!raw || typeof raw !== "object") return DEFAULT_STUDIO_STATE;
  const s = raw as Record<string, unknown>;
  return {
    highlight: sanitizeHighlight(s.highlight),
    poll: sanitizePoll(s.poll),
    goals: sanitizeGoals(s.goals),
    scene: sanitizeScene(s.scene),
    timer: sanitizeTimer(s.timer),
    streamStartMs:
      Number.isFinite(Number(s.streamStartMs)) && Number(s.streamStartMs) > 0
        ? Number(s.streamStartMs)
        : null,
    vodUrl: sanitizeVodUrl(s.vodUrl),
    blockedUsers: (Array.isArray(s.blockedUsers) ? s.blockedUsers : []).filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    ),
    recapSeq: Math.max(0, Math.round(Number(s.recapSeq) || 0)),
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null,
  };
}

/**
 * Live studio state for one overlay token. ``studioEvent`` is the
 * latest raw ``overlay:multichat`` socket payload as tracked by the
 * host client — applied whenever its identity changes. The periodic
 * refetch is a missed-event fallback only: a fetch result never
 * clobbers a socket payload that landed while it was in flight.
 *
 * ``options.enabled: false`` keeps the default state and skips the
 * poll entirely, for callers that render sample values instead of
 * live ones (``?demo=1``). Without it every open Settings tab would
 * poll a token's studio state once a minute, forever, and throw the
 * answer away.
 */
export function useStudioState(
  token: string,
  studioEvent: unknown,
  options?: { enabled?: boolean },
): StudioState & { loaded: boolean } {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<StudioState>(DEFAULT_STUDIO_STATE);
  const [loaded, setLoaded] = useState(false);
  // Wall-clock of the last applied socket payload — fetch results
  // started before this stamp are stale and dropped.
  const lastEventAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const startedAt = Date.now();
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/studio`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (cancelled || lastEventAtRef.current > startedAt) return;
        setState(sanitizeStudioState(body));
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const timer = setInterval(load, STUDIO_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, enabled]);

  useEffect(() => {
    if (!studioEvent || typeof studioEvent !== "object") return;
    lastEventAtRef.current = Date.now();
    setState(sanitizeStudioState(studioEvent));
    setLoaded(true);
  }, [studioEvent]);

  return { ...state, loaded };
}
