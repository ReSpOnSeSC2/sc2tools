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

import { useCallback, useEffect, useRef, useState } from "react";
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

/** One time-ranged YouTube segment in the reusable BRB/Starting Soon reel. */
export interface StudioBrollClip {
  id: string;
  title: string;
  videoId: string;
  startSeconds: number;
  endSeconds: number;
}

/** Persisted player/library controls shared by the Dock and OBS source. */
export interface StudioBrollConfig {
  clips: StudioBrollClip[];
  shuffle: boolean;
  muted: boolean;
  /** Integer percent, 0..100. */
  volume: number;
  /** Changing this counter asks every connected player to advance. */
  skipNonce: number;
}

export const DEFAULT_BROLL_CONFIG: StudioBrollConfig = {
  clips: [],
  shuffle: true,
  muted: false,
  volume: 20,
  skipNonce: 0,
};

export interface StudioState {
  highlight: StudioHighlight | null;
  poll: StudioPoll | null;
  goals: StudioGoal[];
  blockedUsers: string[];
  recapSeq: number;
  scene: StudioScene | null;
  timer: StudioTimer | null;
  broll: StudioBrollConfig;
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
  broll: DEFAULT_BROLL_CONFIG,
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

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const BROLL_CLIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BROLL_MAX_CLIPS = 100;
const BROLL_MAX_SECONDS = 24 * 60 * 60;

/** Client mirror of the API sanitizer. Never lets embed-shaped input through. */
function sanitizeBroll(raw: unknown): StudioBrollConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_BROLL_CONFIG, clips: [] };
  }
  const b = raw as Record<string, unknown>;
  const clips: StudioBrollClip[] = [];
  const seenIds = new Set<string>();
  for (const candidate of Array.isArray(b.clips) ? b.clips : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const clip = candidate as Record<string, unknown>;
    const id = typeof clip.id === "string" ? clip.id.trim() : "";
    const title =
      typeof clip.title === "string" ? clip.title.trim().slice(0, 120) : "";
    const videoId =
      typeof clip.videoId === "string" ? clip.videoId.trim() : "";
    if (
      !BROLL_CLIP_ID_RE.test(id) ||
      seenIds.has(id) ||
      !title ||
      !YOUTUBE_VIDEO_ID_RE.test(videoId) ||
      typeof clip.startSeconds !== "number" ||
      !Number.isFinite(clip.startSeconds) ||
      typeof clip.endSeconds !== "number" ||
      !Number.isFinite(clip.endSeconds)
    ) {
      continue;
    }
    const startSeconds = Math.floor(clip.startSeconds);
    const endSeconds = Math.floor(clip.endSeconds);
    if (
      startSeconds < 0 ||
      endSeconds <= startSeconds ||
      endSeconds > BROLL_MAX_SECONDS
    ) {
      continue;
    }
    clips.push({ id, title, videoId, startSeconds, endSeconds });
    seenIds.add(id);
    if (clips.length >= BROLL_MAX_CLIPS) break;
  }

  const volume =
    typeof b.volume === "number" && Number.isFinite(b.volume)
      ? Math.min(100, Math.max(0, Math.round(b.volume)))
      : DEFAULT_BROLL_CONFIG.volume;
  const skipNonce =
    typeof b.skipNonce === "number" && Number.isFinite(b.skipNonce)
      ? Math.min(2_147_483_647, Math.max(0, Math.floor(b.skipNonce)))
      : DEFAULT_BROLL_CONFIG.skipNonce;

  return {
    clips,
    shuffle:
      typeof b.shuffle === "boolean" ? b.shuffle : DEFAULT_BROLL_CONFIG.shuffle,
    muted:
      typeof b.muted === "boolean" ? b.muted : DEFAULT_BROLL_CONFIG.muted,
    volume,
    skipNonce,
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
    broll: sanitizeBroll(s.broll),
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
  // Ordering guards for the three paths that can deliver the same snapshot:
  // initial/periodic GET, live socket broadcast, and socket connect replay.
  // Local sequences make same-millisecond fetch/event races deterministic;
  // updatedAt stops a delayed replay overwriting a newer live Dock action.
  const socketSequenceRef = useRef(0);
  const fetchSequenceRef = useRef(0);
  // ``applySnapshot`` changes identity when the token changes. Without a
  // separate event-identity guard, React would rerun the socket effect and
  // apply the previous token's last event to the new token. Do not reset this
  // ref in the token effect: an unchanged event is, by definition, stale.
  const lastStudioEventRef = useRef<unknown>(null);
  const latestServerUpdateRef = useRef<{
    token: string;
    atMs: number;
  } | null>(null);

  const applySnapshot = useCallback((raw: unknown): boolean => {
    const next = sanitizeStudioState(raw);
    const parsedUpdate = next.updatedAt ? Date.parse(next.updatedAt) : NaN;
    const serverUpdate = Number.isFinite(parsedUpdate) ? parsedUpdate : null;
    const latest = latestServerUpdateRef.current?.token === token
      ? latestServerUpdateRef.current.atMs
      : null;
    // Once a timestamped state is live, an unversioned snapshot cannot prove
    // it is newer. This matters when a connect replay began before the first
    // ever Dock write and returns the old, empty document afterwards.
    if (latest !== null && (serverUpdate === null || serverUpdate <= latest)) {
      return false;
    }
    if (serverUpdate !== null) {
      latestServerUpdateRef.current = { token, atMs: serverUpdate };
    }
    setState(next);
    return true;
  }, [token]);

  useEffect(() => {
    // A route-level token normally never changes, but Settings previews and
    // tests can reuse the hook instance. Never carry one streamer's scene or
    // ordering watermark into another token while its first snapshot loads.
    latestServerUpdateRef.current = null;
    socketSequenceRef.current += 1;
    fetchSequenceRef.current += 1;
    setState(DEFAULT_STUDIO_STATE);
    setLoaded(false);
  }, [token]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      const fetchSequence = ++fetchSequenceRef.current;
      const socketSequence = socketSequenceRef.current;
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/studio`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (
          cancelled
          || fetchSequence !== fetchSequenceRef.current
          || socketSequence !== socketSequenceRef.current
        ) return;
        applySnapshot(body);
      } catch {
        /* transient — next tick retries */
      } finally {
        if (!cancelled && fetchSequence === fetchSequenceRef.current) {
          setLoaded(true);
        }
      }
    };
    void load();
    const timer = setInterval(load, STUDIO_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token, enabled, applySnapshot]);

  useEffect(() => {
    if (Object.is(lastStudioEventRef.current, studioEvent)) return;
    lastStudioEventRef.current = studioEvent;
    if (!studioEvent || typeof studioEvent !== "object") return;
    socketSequenceRef.current += 1;
    applySnapshot(studioEvent);
    setLoaded(true);
  }, [studioEvent, applySnapshot]);

  return { ...state, loaded };
}
