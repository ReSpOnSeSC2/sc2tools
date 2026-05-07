"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveGamePayload } from "./types";

/**
 * Voice prefs payload. Mirrors the shape persisted by
 * ``/v1/me/preferences/voice`` and emitted on the overlay socket as
 * ``overlay:config.voicePrefs``. All fields are optional so a partial
 * row from the preferences collection still works.
 */
export interface VoicePrefs {
  enabled?: boolean;
  voice?: string;
  rate?: number;
  pitch?: number;
  events?: {
    matchStart?: boolean;
    matchEnd?: boolean;
    cheese?: boolean;
  };
}

/**
 * Public surface of `useVoiceReadout`. Consumers render the gesture
 * banner when ``needsGesture`` is true; clicking it (or anywhere else)
 * fires ``onUserGesture`` which unblocks queued speech.
 */
export interface VoiceReadout {
  /** True when the OBS browser hasn't received a user gesture yet AND
   *  speech is queued waiting for one. The overlay surfaces a banner. */
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
 *   - Scouting readout: pre-game opponent dossier (oppName + race +
 *     headToHead). Always fires when voice is enabled, regardless of
 *     the per-event toggles — same behaviour as the legacy app.
 *   - matchStart: short "Match started" cue when ``events.matchStart``
 *     is on. Wired off the SAME pre-game payload as scouting.
 *   - matchEnd: result + MMR delta when ``events.matchEnd`` is on
 *     and the payload carries a ``result``.
 *   - cheese: "Cheese warning" when ``events.cheese`` is on AND
 *     ``cheeseProbability >= 0.4`` (matches the cheese widget's
 *     visibility threshold).
 *
 * De-duped via a fingerprint of the payload so a re-emit (e.g. an
 * agent re-upload) doesn't speak twice.
 */
export function useVoiceReadout(
  live: LiveGamePayload | null,
  prefs: VoicePrefs | null,
): VoiceReadout {
  const [gestureGranted, setGestureGranted] = useState(false);
  const [pendingUtterance, setPendingUtterance] = useState<string | null>(null);
  const lastFingerprintRef = useRef<string | null>(null);

  const enabled = !!prefs && prefs.enabled !== false;

  // Resolve the chosen voice once the engine reports its catalog. The
  // ref is read inside `speak` so we don't re-render on every voice
  // catalog update.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      voicesRef.current = window.speechSynthesis.getVoices();
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
    };
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Some browsers throw on cancel before any utterance has played.
      }
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = clamp(prefs?.rate ?? 1, 0.5, 2);
      utt.pitch = clamp(prefs?.pitch ?? 1, 0, 2);
      const wantedVoice = prefs?.voice;
      if (wantedVoice) {
        const match = voicesRef.current.find((v) => v.name === wantedVoice);
        if (match) {
          utt.voice = match;
          utt.lang = match.lang || "en-US";
        }
      }
      window.speechSynthesis.speak(utt);
    },
    [prefs?.rate, prefs?.pitch, prefs?.voice],
  );

  const enqueueOrSpeak = useCallback(
    (text: string) => {
      if (!text) return;
      if (gestureGranted) {
        speak(text);
      } else {
        // Hold the most recent utterance only — old payloads aren't
        // worth speaking once the streamer eventually clicks.
        setPendingUtterance(text);
      }
    },
    [gestureGranted, speak],
  );

  // Build + dispatch utterances whenever the live payload changes.
  useEffect(() => {
    if (!enabled || !live) return;
    const fp = fingerprint(live);
    if (fp === lastFingerprintRef.current) return;
    lastFingerprintRef.current = fp;

    const lines: string[] = [];

    // Pre-game scouting card. Fires whenever an opponent name is
    // present without a result — that's the "match starting / about
    // to start" window in the live payload.
    const hasOpp = !!live.oppName && !live.result;
    if (hasOpp) {
      lines.push(buildScoutingLine(live));
      if (prefs?.events?.matchStart) {
        lines.push("Match starting.");
      }
    }

    if (prefs?.events?.matchEnd && live.result) {
      lines.push(buildMatchEndLine(live));
    }

    if (
      prefs?.events?.cheese
      && typeof live.cheeseProbability === "number"
      && live.cheeseProbability >= 0.4
    ) {
      lines.push("Cheese warning.");
    }

    const text = lines.filter(Boolean).join(" ").trim();
    if (text) enqueueOrSpeak(text);
  }, [live, enabled, prefs, enqueueOrSpeak]);

  const onUserGesture = useCallback(() => {
    if (gestureGranted) return;
    setGestureGranted(true);
    if (pendingUtterance) {
      const text = pendingUtterance;
      setPendingUtterance(null);
      // Speak after the gesture flips so the autoplay gate sees the
      // user's click first. A microtask is enough — speak() reads
      // `voicesRef.current` which is already populated.
      window.setTimeout(() => speak(text), 0);
    }
  }, [gestureGranted, pendingUtterance, speak]);

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

  return {
    needsGesture: enabled && pendingUtterance !== null && !gestureGranted,
    enabled,
    onUserGesture,
  };
}

/* ============================================================
 * Utterance builders — small, deterministic, easy to test.
 * ============================================================ */

function buildScoutingLine(live: LiveGamePayload): string {
  const parts: string[] = [];
  const name = live.oppName?.trim();
  const race = live.oppRace?.trim();
  if (name && race) parts.push(`Facing ${name}, ${race}.`);
  else if (name) parts.push(`Facing ${name}.`);
  else if (race) parts.push(`Facing a ${race} opponent.`);

  const r = live.headToHead;
  if (r && (r.wins > 0 || r.losses > 0)) {
    parts.push(`You're ${r.wins} and ${r.losses} against them.`);
  } else if (r) {
    parts.push("First meeting.");
  }

  const a = live.bestAnswer;
  if (a && a.build) {
    const pct = Math.round((a.winRate ?? 0) * 100);
    parts.push(
      pct > 0 ? `Best answer is ${a.build}, ${pct} percent win rate.` : `Best answer is ${a.build}.`,
    );
  }

  return parts.join(" ");
}

function buildMatchEndLine(live: LiveGamePayload): string {
  const word = live.result === "win" ? "Victory" : live.result === "loss" ? "Defeat" : "Match over";
  if (typeof live.mmrDelta === "number" && live.mmrDelta !== 0) {
    const sign = live.mmrDelta > 0 ? "plus" : "minus";
    return `${word}. ${sign} ${Math.abs(live.mmrDelta)} MMR.`;
  }
  return `${word}.`;
}

function fingerprint(live: LiveGamePayload): string {
  return [
    live.oppName ?? "",
    live.oppRace ?? "",
    live.headToHead?.wins ?? 0,
    live.headToHead?.losses ?? 0,
    live.result ?? "",
    live.mmrDelta ?? "",
    live.cheeseProbability ?? "",
    live.isTest ? "T" : "",
  ].join("|");
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
