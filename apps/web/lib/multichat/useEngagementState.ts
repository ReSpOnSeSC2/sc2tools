"use client";

// useEngagementState — client mirror of the engagement summary
// (supporter wall, oracle leaderboard, open prediction, clip
// moments) plus the live ``overlay:engagement`` broadcast stream.
// Same contract as useStudioState: boot fetch, slow refetch as a
// missed-event fallback, socket payloads applied on identity change,
// everything re-sanitized before render.

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { CHAT_PLATFORMS, type ChatPlatform } from "./types";

const REFRESH_MS = 60_000;

export interface WallEntry {
  user: string;
  platform: ChatPlatform;
  xp: number;
  level: number;
  rank: string;
}

export interface OracleEntry {
  user: string;
  platform: ChatPlatform;
  score: number;
  correct: number;
  total: number;
}

export interface PredictionTally {
  win: number;
  loss: number;
  total: number;
}

export interface OpenPrediction {
  gameKey: string;
  opponent: string;
  tally: PredictionTally;
}

export interface ClipMoment {
  atMs: number;
  kind: "chat-spike" | "game-event";
  reason: string;
  sampleLines: string[];
  gameKey?: string;
}

export interface EngagementSummary {
  wall: WallEntry[];
  oracles: OracleEntry[];
  prediction: OpenPrediction | null;
  clipMoments: ClipMoment[];
}

export const EMPTY_ENGAGEMENT: EngagementSummary = {
  wall: [],
  oracles: [],
  prediction: null,
  clipMoments: [],
};

function isPlatform(v: unknown): v is ChatPlatform {
  return CHAT_PLATFORMS.includes(v as ChatPlatform);
}

function str(v: unknown, max = 120): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function sanitizeTally(raw: unknown): PredictionTally {
  const t = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const win = Math.max(0, Math.round(num(t.win)));
  const loss = Math.max(0, Math.round(num(t.loss)));
  return { win, loss, total: win + loss };
}

export function sanitizeEngagement(raw: unknown): EngagementSummary {
  if (!raw || typeof raw !== "object") return EMPTY_ENGAGEMENT;
  const s = raw as Record<string, unknown>;
  const wall = (Array.isArray(s.wall) ? s.wall : [])
    .map((w) => {
      const e = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
      if (!str(e.user)) return null;
      return {
        user: str(e.user, 60),
        platform: isPlatform(e.platform) ? e.platform : ("twitch" as const),
        xp: num(e.xp),
        level: num(e.level),
        rank: str(e.rank, 30) || "Probe",
      };
    })
    .filter((e): e is WallEntry => e !== null)
    .slice(0, 5);
  const oracles = (Array.isArray(s.oracles) ? s.oracles : [])
    .map((w) => {
      const e = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
      if (!str(e.user)) return null;
      return {
        user: str(e.user, 60),
        platform: isPlatform(e.platform) ? e.platform : ("twitch" as const),
        score: num(e.score),
        correct: num(e.correct),
        total: num(e.total),
      };
    })
    .filter((e): e is OracleEntry => e !== null)
    .slice(0, 5);
  const p = (s.prediction && typeof s.prediction === "object"
    ? s.prediction
    : null) as Record<string, unknown> | null;
  const clipMoments = (Array.isArray(s.clipMoments) ? s.clipMoments : [])
    .map((m) => {
      const e = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
      if (!str(e.reason, 160)) return null;
      return {
        atMs: num(e.atMs),
        kind: e.kind === "game-event" ? ("game-event" as const) : ("chat-spike" as const),
        reason: str(e.reason, 160),
        sampleLines: (Array.isArray(e.sampleLines) ? e.sampleLines : [])
          .map((l) => str(l, 200))
          .filter(Boolean)
          .slice(0, 5),
        ...(str(e.gameKey) ? { gameKey: str(e.gameKey) } : {}),
      };
    })
    .filter((m): m is ClipMoment => m !== null)
    .slice(0, 20);
  return {
    wall,
    oracles,
    prediction: p
      ? {
          gameKey: str(p.gameKey),
          opponent: str(p.opponent, 60),
          tally: sanitizeTally(p.tally),
        }
      : null,
    clipMoments,
  };
}

/**
 * Boot summary + live socket merge for one token. ``engagementEvent``
 * is the latest raw ``overlay:engagement`` payload from the host
 * client. Returns the summary plus the latest raw event so widgets
 * can animate transient moments (settles, level-ups, clip flags).
 */
export function useEngagementState(
  token: string,
  engagementEvent: unknown,
): { summary: EngagementSummary; lastEvent: Record<string, unknown> | null } {
  const [summary, setSummary] = useState<EngagementSummary>(EMPTY_ENGAGEMENT);
  const [lastEvent, setLastEvent] = useState<Record<string, unknown> | null>(null);
  const lastEventAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const startedAt = Date.now();
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/engagement`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (cancelled || lastEventAtRef.current > startedAt) return;
        setSummary(sanitizeEngagement(body));
      } catch {
        /* transient — next tick retries */
      }
    };
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    if (!engagementEvent || typeof engagementEvent !== "object") return;
    lastEventAtRef.current = Date.now();
    const ev = engagementEvent as Record<string, unknown>;
    setLastEvent(ev);
    // Live merges that keep the summary fresh between refetches.
    setSummary((prev) => {
      if (ev.type === "prediction-open") {
        return {
          ...prev,
          prediction: {
            gameKey: str(ev.gameKey),
            opponent: str(ev.opponent, 60),
            tally: { win: 0, loss: 0, total: 0 },
          },
        };
      }
      if (ev.type === "prediction-tally" && prev.prediction) {
        return {
          ...prev,
          prediction: { ...prev.prediction, tally: sanitizeTally(ev.tally) },
        };
      }
      if (ev.type === "prediction-settled") {
        return { ...prev, prediction: null };
      }
      if (ev.type === "clip-moment") {
        const m = sanitizeEngagement({ clipMoments: [ev.moment] }).clipMoments;
        return { ...prev, clipMoments: [...m, ...prev.clipMoments].slice(0, 20) };
      }
      return prev;
    });
  }, [engagementEvent]);

  return { summary, lastEvent };
}
