"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveGamePayload } from "./types";

/**
 * Voice prefs payload. Mirrors the shape persisted by
 * ``/v1/me/preferences/voice`` and emitted on the overlay socket as
 * ``overlay:config.voicePrefs``. All fields are optional so a partial
 * row from the preferences collection still works.
 *
 * Schema parity with the legacy `data/config.schema.json`
 * (`config.voice`):
 *   enabled        ↔ enabled
 *   volume         ↔ volume
 *   rate           ↔ rate
 *   pitch          ↔ pitch
 *   delay_ms       ↔ delayMs        (web canonicalises to camelCase)
 *   preferred_voice ↔ voice         (web stores the picked name as `voice`)
 *   events.*       — web addition for per-event toggles (matchStart,
 *                    matchEnd, cheese, scouting). The legacy SPA always
 *                    spoke the scouting card; the web app exposes a
 *                    per-event off switch in Settings → Voice.
 */
export interface VoicePrefs {
  enabled?: boolean;
  /** Picked voice name. Empty / undefined ⇒ use the system default. */
  voice?: string;
  /** Speech rate, 0.5 – 2.0. Defaults to 1. */
  rate?: number;
  /** Speech pitch, 0 – 2. Defaults to 1. */
  pitch?: number;
  /** Speech volume, 0 – 1. Defaults to 1. */
  volume?: number;
  /** Pre-utterance delay in ms (matches legacy `delay_ms`). Defaults to 300. */
  delayMs?: number;
  /** Per-event toggles. Scouting defaults true (legacy parity). */
  events?: {
    matchStart?: boolean;
    matchEnd?: boolean;
    cheese?: boolean;
    scouting?: boolean;
  };
  /** Set true to log diagnostic info regardless of NODE_ENV / URL flag. */
  debug?: boolean;
}

const DEFAULTS = {
  enabled: true,
  volume: 1,
  rate: 1,
  pitch: 1,
  delayMs: 300,
};

/**
 * Public surface of `useVoiceReadout`. Consumers render the gesture
 * banner when ``needsGesture`` is true; clicking it (or anywhere else)
 * fires ``onUserGesture`` which unblocks queued speech.
 */
export interface VoiceReadout {
  /** True when speech is queued waiting for a user gesture. */
  needsGesture: boolean;
  /** True when voicePrefs are loaded and ``enabled !== false``. */
  enabled: boolean;
  /** Mark gesture granted — consumer wires this to a click handler. */
  onUserGesture: () => void;
}

/**
 * Voice readout hook for the OBS overlay clients. Watches the live
 * payload, decides whether anything should be spoken (per the user's
 * voicePrefs), and queues / fires the utterance. Browser autoplay
 * policy blocks Web Speech until a user gesture, so the hook also
 * tracks whether a gesture has been received and exposes a
 * ``needsGesture`` flag the consumer renders as a banner.
 *
 * Triggers (matching the legacy SPA's `voice-readout.js` and the
 * Settings → Voice "events" toggles):
 *
 *   - Scouting readout: pre-game opponent dossier (oppName, optional
 *     race + headToHead + bestAnswer + cheese). Fires when voice is
 *     enabled AND the per-event ``scouting`` toggle is unset / true
 *     (default-on for legacy parity).
 *   - matchStart: short "Match starting" cue when ``events.matchStart``
 *     is on. Wired off the SAME pre-game payload as scouting.
 *   - matchEnd: result + MMR delta when ``events.matchEnd`` is on
 *     and the payload carries a ``result``.
 *   - cheese: "Cheese warning" when ``events.cheese`` is on AND
 *     ``cheeseProbability >= 0.4`` (matches the cheese widget's
 *     visibility threshold).
 *
 * Each trigger has its own fingerprint so the same opponent never gets
 * a second scouting readout, but a separate matchEnd line for the same
 * payload does fire. Re-emits with identical content are suppressed.
 */
export function useVoiceReadout(
  live: LiveGamePayload | null,
  prefs: VoicePrefs | null,
): VoiceReadout {
  const [gestureGranted, setGestureGranted] = useState<boolean>(() =>
    readSessionUnlock(),
  );
  const [pendingUtterance, setPendingUtterance] = useState<string | null>(null);

  // Per-trigger dedupe keys. Scouting and matchEnd dedupe independently
  // so a single payload that has both shapes (e.g. an isTest fire that
  // sets oppName AND result) speaks each line at most once.
  const lastScoutingKey = useRef<string | null>(null);
  const lastMatchEndKey = useRef<string | null>(null);
  const lastCheeseKey = useRef<string | null>(null);
  const lastMatchStartKey = useRef<string | null>(null);

  const enabled = !!prefs && prefs.enabled !== false;
  const debug = useDebugFlag(prefs?.debug);

  const log = useCallback(
    (...args: unknown[]) => {
      if (!debug) return;
      try {
        // eslint-disable-next-line no-console
        console.info("[VoiceReadout]", ...args);
      } catch {
        /* never let logging crash the renderer */
      }
    },
    [debug],
  );

  // Resolve the chosen voice once the engine reports its catalog. The
  // ref is read inside `speak` so we don't re-render on every voice
  // catalog update.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const load = () => {
      voicesRef.current = synth.getVoices();
      log("voices loaded:", voicesRef.current.length);
    };
    load();
    synth.addEventListener("voiceschanged", load);
    return () => {
      synth.removeEventListener("voiceschanged", load);
    };
  }, [log]);

  // Some Chromium versions auto-pause synth ~15s after the tab loses
  // focus. The defensive resume() trick keeps long utterances alive
  // while the OBS Browser Source is technically backgrounded. Cheap —
  // it's a no-op when nothing is queued.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const synth = window.speechSynthesis;
    const id = window.setInterval(() => {
      if (synth.speaking && synth.paused) {
        try {
          synth.resume();
        } catch {
          /* best-effort */
        }
      }
    }, 8000);
    const onVisibility = () => {
      if (synth.speaking) {
        try {
          synth.resume();
        } catch {
          /* best-effort */
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      const sanitized = sanitizeForSpeech(text);
      if (!sanitized) {
        log("skip speak: empty after sanitize");
        return;
      }
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
      } catch {
        // Some browsers throw on cancel before any utterance has played.
      }
      const utt = new SpeechSynthesisUtterance(sanitized);
      utt.rate = clamp(prefs?.rate ?? DEFAULTS.rate, 0.5, 2);
      utt.pitch = clamp(prefs?.pitch ?? DEFAULTS.pitch, 0, 2);
      utt.volume = clamp(prefs?.volume ?? DEFAULTS.volume, 0, 1);
      const wantedVoice = prefs?.voice;
      if (wantedVoice) {
        const match = voicesRef.current.find((v) => v.name === wantedVoice);
        if (match) {
          utt.voice = match;
          utt.lang = match.lang || "en-US";
          log("voice =", match.name, match.lang);
        } else {
          log("preferred voice not found:", wantedVoice);
        }
      }
      utt.onerror = (ev) => {
        const code = (ev as SpeechSynthesisErrorEvent).error || "unknown";
        // 'interrupted' / 'canceled' fire whenever we proactively cancel
        // the previous utterance; not a user-visible error.
        if (code === "interrupted" || code === "canceled") return;
        try {
          // eslint-disable-next-line no-console
          console.warn("[VoiceReadout] utterance error:", code);
        } catch {
          /* never let logging crash the renderer */
        }
        if (code === "not-allowed") {
          // Browser revoked the unlock (e.g. session ended); restart
          // the gesture flow on the next payload.
          clearSessionUnlock();
          setGestureGranted(false);
        }
      };
      const delay = clamp(prefs?.delayMs ?? DEFAULTS.delayMs, 0, 5000);
      log("speak:", JSON.stringify(sanitized), "delay=" + delay);
      if (delay > 0) {
        window.setTimeout(() => {
          try {
            synth.speak(utt);
          } catch {
            /* best-effort */
          }
        }, delay);
      } else {
        try {
          synth.speak(utt);
        } catch {
          /* best-effort */
        }
      }
    },
    [prefs?.rate, prefs?.pitch, prefs?.voice, prefs?.volume, prefs?.delayMs, log],
  );

  const enqueueOrSpeak = useCallback(
    (text: string) => {
      if (!text) return;
      if (gestureGranted) {
        speak(text);
      } else {
        // Hold the most recent utterance only — old payloads aren't
        // worth speaking once the streamer eventually clicks.
        log("queue (waiting for gesture):", text);
        setPendingUtterance(text);
      }
    },
    [gestureGranted, speak, log],
  );

  // Cancel in-flight utterance when the *opponent* changes mid-flight.
  // A new opponent reveal supersedes the old scouting line even if the
  // old one is still mid-sentence.
  const lastOppRef = useRef<string | null>(null);
  useEffect(() => {
    const opp = (live?.oppName || "").trim().toLowerCase() || null;
    if (lastOppRef.current && opp && opp !== lastOppRef.current) {
      log("opponent changed:", lastOppRef.current, "→", opp);
      try {
        window.speechSynthesis?.cancel();
      } catch {
        /* best-effort */
      }
      // Clear the scouting fingerprint so the new opponent gets its own
      // readout even if (theoretically) the H2H is identical.
      lastScoutingKey.current = null;
      lastMatchStartKey.current = null;
    }
    if (opp) lastOppRef.current = opp;
  }, [live?.oppName, log]);

  // Build + dispatch utterances whenever the live payload changes.
  useEffect(() => {
    if (!enabled || !live) return;
    const events = prefs?.events || {};
    const wantsScouting = events.scouting !== false; // default-on
    const lines: string[] = [];

    // Pre-game scouting card. Fires whenever an opponent name is
    // present without a result — that's the "match starting / about
    // to start" window in the live payload.
    const hasOpp = !!live.oppName && !live.result;
    if (hasOpp) {
      if (wantsScouting) {
        const key = scoutingFingerprint(live);
        if (key && key !== lastScoutingKey.current) {
          lastScoutingKey.current = key;
          const line = buildScoutingLine(live);
          if (line) lines.push(line);
        } else {
          log("scouting suppressed (duplicate fingerprint)", key);
        }
      }
      if (events.matchStart) {
        const key = matchStartFingerprint(live);
        if (key && key !== lastMatchStartKey.current) {
          lastMatchStartKey.current = key;
          lines.push("Match starting.");
        }
      }
    }

    if (events.matchEnd && live.result) {
      const key = matchEndFingerprint(live);
      if (key && key !== lastMatchEndKey.current) {
        lastMatchEndKey.current = key;
        lines.push(buildMatchEndLine(live));
      }
    }

    if (
      events.cheese
      && typeof live.cheeseProbability === "number"
      && live.cheeseProbability >= 0.4
    ) {
      const key = cheeseFingerprint(live);
      if (key && key !== lastCheeseKey.current) {
        lastCheeseKey.current = key;
        lines.push(buildCheeseLine(live));
      }
    }

    const text = lines.filter(Boolean).join(" ").trim();
    if (text) {
      log("payload triggered readout:", JSON.stringify(text));
      enqueueOrSpeak(text);
    } else {
      log("payload produced no readout", { hasOpp, result: live.result });
    }
  }, [live, enabled, prefs, enqueueOrSpeak, log]);

  const onUserGesture = useCallback(() => {
    if (gestureGranted) return;
    setGestureGranted(true);
    persistSessionUnlock();
    log("gesture granted, replaying queued utterance:", pendingUtterance);
    if (pendingUtterance) {
      const text = pendingUtterance;
      setPendingUtterance(null);
      // Speak after the gesture flips so the autoplay gate sees the
      // user's click first. A microtask is enough — speak() reads
      // `voicesRef.current` which is already populated.
      window.setTimeout(() => speak(text), 0);
    }
  }, [gestureGranted, pendingUtterance, speak, log]);

  // Cancel any in-flight utterance when the host unmounts so a
  // Browser Source refresh doesn't leave an orphaned voice queue.
  useEffect(() => {
    return () => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
      } catch {
        // best-effort
      }
    };
  }, []);

  return useMemo<VoiceReadout>(
    () => ({
      needsGesture: enabled && pendingUtterance !== null && !gestureGranted,
      enabled,
      onUserGesture,
    }),
    [enabled, pendingUtterance, gestureGranted, onUserGesture],
  );
}

/* ============================================================
 * Utterance builders — small, deterministic, easy to test.
 * Exported (named) for unit tests.
 * ============================================================ */

const MAX_BEST_ANSWER_LEN = 60;

export function buildScoutingLine(live: LiveGamePayload): string {
  const parts: string[] = [];
  const name = sanitizeForSpeech(live.oppName);
  const race = normalizeRace(live.oppRace);

  if (name && race) parts.push(`Facing ${name}, ${race}.`);
  else if (name) parts.push(`Facing ${name}.`);
  else if (race) parts.push(`Facing a ${race} opponent.`);
  else parts.push("Facing an unknown opponent.");

  const r = live.headToHead;
  const wins = Number(r?.wins);
  const losses = Number(r?.losses);
  if (Number.isFinite(wins) && Number.isFinite(losses) && (wins > 0 || losses > 0)) {
    parts.push(`You're ${wins} and ${losses} against them.`);
  } else if (r) {
    parts.push("First meeting.");
  }

  const a = live.bestAnswer;
  if (a && a.build) {
    const build = truncate(sanitizeForSpeech(a.build), MAX_BEST_ANSWER_LEN);
    const wr = Number(a.winRate);
    if (build) {
      if (Number.isFinite(wr) && wr > 0) {
        const pct = Math.round(wr * 100);
        parts.push(`Best answer is ${build}, ${pct} percent win rate.`);
      } else {
        parts.push(`Best answer is ${build}.`);
      }
    }
  }

  const cheese = Number(live.cheeseProbability);
  if (Number.isFinite(cheese)) {
    if (cheese >= 0.7) parts.push("High cheese risk — scout early.");
    else if (cheese >= 0.4) parts.push("Possible cheese — scout the natural.");
  }

  return parts.filter(Boolean).join(" ");
}

export function buildMatchEndLine(live: LiveGamePayload): string {
  const word =
    live.result === "win"
      ? "Victory"
      : live.result === "loss"
        ? "Defeat"
        : "Match over";
  const delta = Number(live.mmrDelta);
  if (Number.isFinite(delta) && delta !== 0) {
    const sign = delta > 0 ? "plus" : "minus";
    return `${word}. ${sign} ${Math.abs(delta)} MMR.`;
  }
  return `${word}.`;
}

export function buildCheeseLine(live: LiveGamePayload): string {
  const cheese = Number(live.cheeseProbability);
  if (!Number.isFinite(cheese)) return "Cheese warning.";
  if (cheese >= 0.7) return "High cheese risk.";
  return "Cheese warning.";
}

/* ============================================================
 * Internals.
 * ============================================================ */

function scoutingFingerprint(live: LiveGamePayload): string {
  return [
    "S",
    (live.oppName || "").toLowerCase(),
    normalizeRace(live.oppRace) || "",
    live.headToHead?.wins ?? "",
    live.headToHead?.losses ?? "",
    live.bestAnswer?.build || "",
    live.isTest ? "T" : "",
  ].join("|");
}

function matchEndFingerprint(live: LiveGamePayload): string {
  return [
    "E",
    (live.oppName || "").toLowerCase(),
    live.result ?? "",
    live.mmrDelta ?? "",
    live.isTest ? "T" : "",
  ].join("|");
}

function matchStartFingerprint(live: LiveGamePayload): string {
  return [
    "M",
    (live.oppName || "").toLowerCase(),
    live.headToHead?.wins ?? "",
    live.headToHead?.losses ?? "",
    live.isTest ? "T" : "",
  ].join("|");
}

function cheeseFingerprint(live: LiveGamePayload): string {
  return [
    "C",
    (live.oppName || "").toLowerCase(),
    Math.round(((live.cheeseProbability ?? 0) as number) * 10),
    live.isTest ? "T" : "",
  ].join("|");
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  // Trim on a word boundary when possible so the TTS doesn't read a
  // partial word.
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > max - 16 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Strip emojis, markdown punctuation, and other characters Web Speech
 * either skips or pronounces awkwardly. Defensive — payloads can carry
 * arbitrary build-name strings.
 */
export function sanitizeForSpeech(input: string | undefined | null): string {
  if (input == null) return "";
  let s = String(input);
  // Markdown link [text](url) → text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  // Inline markdown markers
  s = s.replace(/[*_`~>#]/g, " ");
  // Strip emoji + the joiners/variation selectors that escort them.
  // Web Speech engines either skip these silently or pronounce the
  // CLDR name ("smiling face with smiling eyes"), neither of which we
  // want in a scouting readout.
  s = s.replace(/[\p{Extended_Pictographic}\u200D\uFE0F]/gu, "");
  // Collapse whitespace and trim.
  return s.replace(/\s+/g, " ").trim();
}

function normalizeRace(race: string | undefined): string {
  if (!race) return "";
  const r = race.trim().toLowerCase();
  if (r === "terran" || r === "zerg" || r === "protoss") {
    return r.charAt(0).toUpperCase() + r.slice(1);
  }
  if (r === "random") return "random race";
  // Anything else (empty / "unknown" / agent ambiguity) — drop the race.
  return "";
}

const SESSION_UNLOCK_KEY = "sc2tools.voiceUnlocked";

function readSessionUnlock(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage?.getItem(SESSION_UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSessionUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.setItem(SESSION_UNLOCK_KEY, "1");
  } catch {
    /* storage may be denied (private mode) — fine, we still unlock for
     * this tab via React state. */
  }
}

function clearSessionUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage?.removeItem(SESSION_UNLOCK_KEY);
  } catch {
    /* best-effort */
  }
}

function useDebugFlag(prefDebug: boolean | undefined): boolean {
  return useMemo(() => {
    if (prefDebug) return true;
    if (typeof window === "undefined") return false;
    try {
      const flag = new URLSearchParams(window.location.search).get(
        "voiceDebug",
      );
      return flag === "1" || flag === "true";
    } catch {
      return false;
    }
  }, [prefDebug]);
}
