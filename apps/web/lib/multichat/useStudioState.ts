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

export interface StudioState {
  highlight: StudioHighlight | null;
  poll: StudioPoll | null;
  goals: StudioGoal[];
  blockedUsers: string[];
  recapSeq: number;
  scene: StudioScene | null;
  updatedAt: string | null;
}

export const DEFAULT_STUDIO_STATE: StudioState = {
  highlight: null,
  poll: null,
  goals: [],
  blockedUsers: [],
  recapSeq: 0,
  scene: null,
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
  return {
    question,
    options,
    startedAtMs: Number.isFinite(Number(p.startedAtMs))
      ? Number(p.startedAtMs)
      : 0,
    status: p.status === "closed" ? "closed" : "open",
  };
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

/**
 * Narrow an untrusted wire value (GET body or socket payload) to a
 * fully-defaulted StudioState. Never throws.
 */
export function sanitizeStudioState(raw: unknown): StudioState {
  if (!raw || typeof raw !== "object") return DEFAULT_STUDIO_STATE;
  const s = raw as Record<string, unknown>;
  return {
    highlight: sanitizeHighlight(s.highlight),
    poll: sanitizePoll(s.poll),
    goals: sanitizeGoals(s.goals),
    scene: sanitizeScene(s.scene),
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
 */
export function useStudioState(
  token: string,
  studioEvent: unknown,
): StudioState & { loaded: boolean } {
  const [state, setState] = useState<StudioState>(DEFAULT_STUDIO_STATE);
  const [loaded, setLoaded] = useState(false);
  // Wall-clock of the last applied socket payload — fetch results
  // started before this stamp are stale and dropped.
  const lastEventAtRef = useRef(0);

  useEffect(() => {
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
  }, [token]);

  useEffect(() => {
    if (!studioEvent || typeof studioEvent !== "object") return;
    lastEventAtRef.current = Date.now();
    setState(sanitizeStudioState(studioEvent));
    setLoaded(true);
  }, [studioEvent]);

  return { ...state, loaded };
}
