"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "./types";
import {
  buildScoutingLine,
  buildMatchEndLine,
  buildCheeseLine,
  buildLiveGameScoutingLine,
  sanitizeForSpeech,
  scoutingFingerprint,
  matchEndFingerprint,
  matchStartFingerprint,
  cheeseFingerprint,
} from "./useVoiceReadout.builders";

// Re-export builders so existing call sites (and the unit tests) can
// keep importing from this module without breaking on the file split.
export {
  buildScoutingLine,
  buildMatchEndLine,
  buildCheeseLine,
  buildLiveGameScoutingLine,
  sanitizeForSpeech,
} from "./useVoiceReadout.builders";

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
 * Window the hook waits for cloud enrichment to land on a fresh
 * ``liveGame`` envelope before speaking the fallback line. Calibrated
 * against the broker's partial-then-enriched fan-out: the partial
 * arrives synchronously, the Mongo aggregation that produces
 * ``streamerHistory`` typically lands within 50–300 ms. 900 ms gives
 * enrichment plenty of headroom while still firing the readout well
 * within the streamer's loading-screen attention budget.
 */
const LIVE_GAME_ENRICHMENT_WAIT_MS = 900;

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
 * Per-gameKey state for the live-envelope readout. Tracks whether the
 * spoken line has already fired for this match AND any pending timer
 * that's waiting for cloud enrichment to land. Stored in a ref so the
 * hook doesn't re-render on every state transition.
 */
interface LiveGameUtterState {
  spoken: boolean;
  timer: number | null;
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
  liveGame?: LiveGameEnvelope | null,
): VoiceReadout {
  const [gestureGranted, setGestureGranted] = useState<boolean>(() =>
    readPersistedUnlock(),
  );
  const [pendingUtterance, setPendingUtterance] = useState<string | null>(null);

  // Per-trigger dedupe keys. Scouting and matchEnd dedupe independently
  // so a single payload that has both shapes (e.g. an isTest fire that
  // sets oppName AND result) speaks each line at most once.
  const lastScoutingKey = useRef<string | null>(null);
  const lastMatchEndKey = useRef<string | null>(null);
  const lastCheeseKey = useRef<string | null>(null);
  const lastMatchStartKey = useRef<string | null>(null);

  // Per-gameKey state for the live-envelope readout. A single match
  // produces 5+ envelope deltas (loading → started → in-progress → ended)
  // plus a Pulse-enriched re-emit; we speak at most once per gameKey
  // AFTER enrichment lands (or after a short timeout, whichever fires
  // first).
  const liveGameStates = useRef<Map<string, LiveGameUtterState>>(new Map());

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
          // the gesture flow on the next payload. Re-queue the text
          // we just tried so the next gesture replays it instead of
          // dropping the line silently.
          clearPersistedUnlock();
          setGestureGranted(false);
          setPendingUtterance(sanitized);
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

  // Cancel in-flight utterance when the *opponent* changes mid-flight,
  // but ONLY when the new payload is a fresh pre-game reveal (no
  // ``result`` set). A finished-game payload — historical replay sync,
  // post-game match-result widget refresh — must not interrupt the
  // current scouting line. The cloud emits one ``overlay:live`` per
  // accepted game during ingest (see apps/api/src/routes/games.js), so
  // a backfill of N games would otherwise cancel the in-flight readout
  // N times in a row before it ever finished a sentence. Sync uploads
  // always carry ``result``; a real pre-game opponent reveal does not.
  const lastOppRef = useRef<string | null>(null);
  useEffect(() => {
    const opp = (live?.oppName || "").trim().toLowerCase() || null;
    const isFreshPreGame = !!opp && !live?.result;
    if (lastOppRef.current && isFreshPreGame && opp !== lastOppRef.current) {
      log("opponent changed (pre-game):", lastOppRef.current, "→", opp);
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
    // Only track pre-game opponents — a finished-game oppName landing
    // here would clobber the legitimate pre-game opp we want to compare
    // against on the *next* real reveal.
    if (isFreshPreGame) lastOppRef.current = opp;
  }, [live?.oppName, live?.result, log]);

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

  // Pre-game / in-game readout, driven by the desktop agent's
  // ``LiveGameEnvelope`` rather than the post-game ``LiveGamePayload``.
  // Speaks at most once per ``gameKey`` AFTER enrichment lands — or
  // after a short timeout if enrichment hasn't arrived yet — so the
  // streamer never hears half a sentence and never hears the readout
  // twice for the same match.
  //
  // Why the timeout exists: the broker's partial-then-enriched fan-out
  // is normally fast (<300 ms), but a Pulse / Mongo blip could leave a
  // partial envelope without any enriched re-emit. The 900 ms fallback
  // means the readout still fires (with whatever data we have) instead
  // of going silent for the streamer.
  //
  // Why we don't fire from this path when ``live`` is set: the post-
  // game payload has identical or stricter information, and letting
  // both fire would speak twice for the same match. The ScoutingWidget
  // consumes ``liveGame`` exclusively when ``live`` is null; voice
  // mirrors that priority.
  useEffect(() => {
    if (!enabled) return;
    if (live) return; // post-game path owns the readout when present
    const states = liveGameStates.current;
    if (!liveGame) return;
    if (liveGame.phase === "idle" || liveGame.phase === "menu") {
      // Drop ALL per-gameKey state — the bridge has cleared back to
      // menu, so the next match-loading envelope starts fresh and
      // gets its own readout.
      for (const entry of states.values()) {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
      }
      states.clear();
      return;
    }
    const oppName = liveGame.opponent?.name?.trim();
    if (!oppName) return;
    const events = prefs?.events || {};
    const wantsScouting = events.scouting !== false;
    const wantsMatchStart = !!events.matchStart;
    if (!wantsScouting && !wantsMatchStart) return;

    const gameKey = liveGame.gameKey || `live:${oppName}`;
    let entry = states.get(gameKey);
    if (!entry) {
      entry = { spoken: false, timer: null };
      states.set(gameKey, entry);
    }
    if (entry.spoken) return;

    const hasEnrichment = !!liveGame.streamerHistory;

    const fireUtterance = () => {
      // The latest envelope captured in the closure may be stale by
      // the time the timer fires, but the hook's render cycle keeps
      // the latest envelope reachable through ``liveGameStates``; we
      // re-read ``liveGame`` via the closure here intentionally —
      // it's the snapshot at the moment we decided to speak. The next
      // render will recompute and either match (no-op, already
      // spoken) or detect a new gameKey.
      const slot = states.get(gameKey);
      if (!slot || slot.spoken) return;
      slot.spoken = true;
      if (slot.timer !== null) {
        window.clearTimeout(slot.timer);
        slot.timer = null;
      }
      const lines: string[] = [];
      if (wantsScouting) {
        const line = buildLiveGameScoutingLine(liveGame);
        if (line) lines.push(line);
      }
      if (wantsMatchStart) lines.push("Match starting.");
      const text = lines.join(" ").trim();
      if (text) {
        log("liveGame triggered readout:", JSON.stringify(text));
        enqueueOrSpeak(text);
      }
    };

    if (hasEnrichment) {
      // Cloud's enrichment has landed — speak now, cancel any pending
      // fallback timer.
      if (entry.timer !== null) {
        window.clearTimeout(entry.timer);
        entry.timer = null;
      }
      fireUtterance();
      return;
    }

    // Enrichment hasn't landed yet. Arm a fallback timer (once per
    // gameKey) so a Pulse / Mongo blip can't gag the readout forever.
    if (entry.timer === null) {
      entry.timer = window.setTimeout(() => {
        const slot = states.get(gameKey);
        if (slot) slot.timer = null;
        fireUtterance();
      }, LIVE_GAME_ENRICHMENT_WAIT_MS);
    }
  }, [liveGame, live, enabled, prefs, enqueueOrSpeak, log]);

  // Drain pending live-game timers on unmount so a Browser Source
  // refresh doesn't leave orphaned setTimeouts attached to a torn-down
  // hook instance.
  useEffect(() => {
    const states = liveGameStates.current;
    return () => {
      for (const entry of states.values()) {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
      }
      states.clear();
    };
  }, []);

  const onUserGesture = useCallback(() => {
    if (gestureGranted) return;
    log("gesture granted");
    setGestureGranted(true);
    persistUnlock();
  }, [gestureGranted, log]);

  // Replay the queued utterance once the gesture flips to granted —
  // whether the unlock came from the banner click, a document-wide
  // gesture, or sessionStorage rehydration. Decoupling replay from the
  // grant call lets all three sources share the same path.
  useEffect(() => {
    if (!gestureGranted) return;
    if (!pendingUtterance) return;
    const text = pendingUtterance;
    setPendingUtterance(null);
    log("replaying queued utterance:", text);
    // Speak on a microtask so the gesture state flip lands first; the
    // autoplay gate has to see the activation before the speak() call.
    window.setTimeout(() => speak(text), 0);
  }, [gestureGranted, pendingUtterance, speak, log]);

  // Document-wide gesture listener — mirrors the legacy SPA's
  // `voice-readout.js` UX where ANY click / keydown / touch on the page
  // unlocked speech. Without this the streamer has to find and click
  // the small fixed-position banner specifically; with it, anywhere on
  // the OBS Browser Source counts (right-click → Interact → click the
  // overlay area). Listener is removed once the gesture is granted so
  // we don't keep eavesdropping on every click for the rest of the
  // session.
  useEffect(() => {
    if (!enabled || gestureGranted) return;
    if (typeof document === "undefined") return;
    const grant = () => {
      log("document gesture detected");
      setGestureGranted(true);
      persistUnlock();
    };
    document.addEventListener("click", grant, { capture: true });
    document.addEventListener("keydown", grant, { capture: true });
    document.addEventListener("touchstart", grant, { capture: true });
    return () => {
      document.removeEventListener("click", grant, { capture: true });
      document.removeEventListener("keydown", grant, { capture: true });
      document.removeEventListener("touchstart", grant, { capture: true });
    };
  }, [enabled, gestureGranted, log]);

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
      // Show the banner as soon as voice is configured but the unlock
      // hasn't happened yet, so the streamer can pre-click during OBS
      // setup instead of having to catch the banner inside the 22s
      // scouting visibility window. A document-wide click also unlocks
      // (see the gesture-listener effect above), but the banner stays
      // as a visible affordance because OBS Browser Sources need
      // Interact mode for clicks to register at all.
      needsGesture: enabled && !gestureGranted,
      enabled,
      onUserGesture,
    }),
    [enabled, gestureGranted, onUserGesture],
  );
}

/* ============================================================
 * Internals — gesture persistence + debug flag.
 * ============================================================ */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

const UNLOCK_STORAGE_KEY = "sc2tools.voiceUnlocked";

/**
 * Read the persisted unlock flag. Prefers localStorage so the unlock
 * survives an OBS Browser Source refresh / OBS restart; falls back to
 * sessionStorage when localStorage is blocked (e.g. private mode).
 *
 * Without persistence the streamer would have to right-click → Interact
 * → click the overlay every time OBS reloads the Source — exactly the
 * paper cut the legacy SPA dodged with a one-time `attachGestureListeners`.
 */
function readPersistedUnlock(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage?.getItem(UNLOCK_STORAGE_KEY) === "1") return true;
  } catch {
    /* localStorage blocked — try sessionStorage next */
  }
  try {
    return window.sessionStorage?.getItem(UNLOCK_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(UNLOCK_STORAGE_KEY, "1");
    return;
  } catch {
    /* localStorage blocked — fall back to sessionStorage */
  }
  try {
    window.sessionStorage?.setItem(UNLOCK_STORAGE_KEY, "1");
  } catch {
    /* both blocked (private mode + storage denied) — fine, the React
     * state unlock still works for this tab's lifetime. */
  }
}

function clearPersistedUnlock(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.removeItem(UNLOCK_STORAGE_KEY);
  } catch {
    /* best-effort */
  }
  try {
    window.sessionStorage?.removeItem(UNLOCK_STORAGE_KEY);
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
