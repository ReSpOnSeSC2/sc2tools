"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "./types";
import {
  buildScoutingLine,
  buildMatchEndLine,
  buildCheeseLine,
  buildLiveGameScoutingLine,
  cheeseFingerprint,
  isLiveGameMmrReady,
  matchEndFingerprint,
  matchStartFingerprint,
  sanitizeForSpeech,
  scoutingFingerprint,
} from "./useVoiceReadout.builders";
import {
  clearPersistedUnlock,
  persistUnlock,
  readPersistedUnlock,
} from "./useVoiceReadout.gesture";
import {
  consumeFingerprint,
  resetPreGameFingerprints,
  resetScoutingFingerprints,
  useScoutingFingerprints,
} from "./useVoiceReadout.dedup";

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
  /**
   * BCP-47 language tag of the picked voice (e.g. ``en-US``), captured
   * in Settings from ``SpeechSynthesisVoice.lang`` at selection time.
   * Lets the overlay fall back to a same-language voice when the exact
   * voice name isn't installed in the runtime that actually does the
   * speaking — the classic OBS / Streamlabs case, where the Browser
   * Source's embedded Chromium (CEF) ships only the local OS voices
   * and lacks the Chrome-only "Google …" voices the streamer sees in
   * Settings. Optional: prefs saved before this field existed fall back
   * to inferring the language from the voice name instead.
   */
  voiceLang?: string;
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

const VOICE_CATALOG_RETRY_MS = 100;
const VOICE_CATALOG_RETRY_LIMIT_MS = 2000;
const VOICE_CATALOG_MAX_ATTEMPTS = Math.ceil(
  VOICE_CATALOG_RETRY_LIMIT_MS / VOICE_CATALOG_RETRY_MS,
);

/**
 * Per-readiness-signal fallback windows. The hook waits for cloud
 * enrichment AND a usable MMR source before firing the live-envelope
 * scouting line; these constants cap how long it'll wait for each
 * signal before falling back to whatever data is in hand.
 *
 * **Why two windows, not one.** The two signals have different
 * latency profiles AND different consequences for the spoken line:
 *
 *   * ``streamerHistory`` (cloud's Mongo aggregation) — produces the
 *     H2H / "First meeting." clause. For repeat opponents on a warm
 *     cache the partial-then-enriched fan-out lands within 50–300 ms,
 *     but for first-meeting opponents on a cold path the three-tier
 *     identity lookup (``pulse_character_id`` → ``toon_handle`` →
 *     display name) PLUS four sequential games-collection
 *     aggregations (streak / recentGames / topBuilds / meta) can
 *     realistically take 1.8–2.5 s on Atlas — and Atlas GC pauses,
 *     pool contention, or a Render container cold start under load
 *     push that past 3 s. A streamer hitting a brand-new opponent
 *     should still hear "First meeting." — silently dropping the
 *     clause is a regression the 900 ms ceiling caused in practice
 *     (2026-05-12 stream repro). 5 s gives ~2× headroom over the
 *     realistic worst-case cold path while still firing well within
 *     SC2's 10–30 s loading-screen attention budget.
 *   * MMR (``opponent.profile.mmr`` from SC2Pulse, or saved last-game
 *     MMR from ``streamerHistory.oppMmr``) — bounded by the agent's
 *     Pulse HTTP timeout, ~900 ms in the worst case. A longer wait
 *     for MMR doesn't buy us anything because Pulse either responded
 *     by then or it's down for this match.
 *
 * Selection rule in the effect: if ``streamerHistory`` is missing,
 * use the enrichment window (longer). If ``streamerHistory`` is
 * present but MMR isn't, use the MMR window (shorter). When both are
 * missing the longer window applies — once enrichment arrives the
 * existing timer continues, so worst case we wait the enrichment
 * window even if MMR could have shortened the wait.
 */
const ENRICHMENT_FALLBACK_WAIT_MS = 5000;
const MMR_FALLBACK_WAIT_MS = 900;

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

type LiveGameStates = Map<string, LiveGameUtterState>;

/**
 * Drop every per-gameKey entry and cancel any pending fallback
 * timers. Shared by the idle/menu reset branch and the unmount
 * cleanup effect.
 */
function clearAllLiveGameTimers(states: LiveGameStates): void {
  for (const entry of states.values()) {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
  }
  states.clear();
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
  // sets oppName AND result) speaks each line at most once. The bundle
  // is shared with the live-envelope match-transition effect below so
  // both the "stamp on speak" and "wipe on new match" call sites read
  // from a single source of truth (see ``useVoiceReadout.dedup``).
  const fingerprints = useScoutingFingerprints();

  // Per-gameKey state for the live-envelope readout. A single match
  // produces 5+ envelope deltas (loading → started → in-progress → ended)
  // plus a Pulse-enriched re-emit; we speak at most once per gameKey
  // AFTER enrichment lands (or after a short timeout, whichever fires
  // first).
  const liveGameStates = useRef<LiveGameStates>(new Map());
  // Most recent ``gameKey`` we processed in the live-envelope effect.
  // Used to detect match transitions so we can clear stale per-gameKey
  // state AND the post-game fingerprint refs — without this, an old
  // ``entry.spoken = true`` from game N can block game N+1 (most
  // visibly when the agent's ``gameKey`` collides on a rematch against
  // the same opponent, where the fallback ``live:${oppName}`` key
  // produces a hash collision and the hook silently skips the readout).
  const lastLiveGameKeyRef = useRef<string | null>(null);

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
  const speakRequestRef = useRef(0);
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
      const requestId = ++speakRequestRef.current;
      const wantedVoice = prefs?.voice;
      const wantedLang = prefs?.voiceLang;
      const dispatch = (attempt = 0) => {
        if (requestId !== speakRequestRef.current) return;
        const { voice: match, catalogEmpty } = resolvePreferredVoice(
          synth,
          voicesRef,
          wantedVoice,
          wantedLang,
        );
        // Retry ONLY while the engine hasn't reported any voice yet —
        // Chromium / CEF populate the catalog asynchronously and the
        // first speak can lose the race. Once the catalog is non-empty
        // but the wanted voice still isn't in it, the voice simply isn't
        // installed in THIS runtime (e.g. the streamer picked a
        // Chrome-only "Google …" voice that the OBS / Streamlabs Browser
        // Source's CEF doesn't ship). Retrying can't conjure it, so fall
        // straight through to the same-language fallback below instead of
        // stalling for the full 2 s budget on every single readout.
        if (
          wantedVoice
          && !match
          && catalogEmpty
          && attempt < VOICE_CATALOG_MAX_ATTEMPTS
        ) {
          log("waiting for voice catalog (empty); wanted:", wantedVoice);
          window.setTimeout(
            () => dispatch(attempt + 1),
            VOICE_CATALOG_RETRY_MS,
          );
          return;
        }
        const utt = new SpeechSynthesisUtterance(sanitized);
        utt.rate = clamp(prefs?.rate ?? DEFAULTS.rate, 0.5, 2);
        utt.pitch = clamp(prefs?.pitch ?? DEFAULTS.pitch, 0, 2);
        utt.volume = clamp(prefs?.volume ?? DEFAULTS.volume, 0, 1);
        if (match) {
          utt.voice = match;
          utt.lang = match.lang || "en-US";
          if (wantedVoice && match.name !== wantedVoice) {
            log(
              "preferred voice unavailable here; same-language fallback:",
              wantedVoice,
              "→",
              match.name,
              match.lang,
            );
          } else {
            log("voice =", match.name, match.lang);
          }
        } else if (wantedVoice) {
          log("preferred voice not found, no same-language fallback:", wantedVoice);
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
        try {
          synth.speak(utt);
        } catch {
          /* best-effort */
        }
      };
      const delay = clamp(prefs?.delayMs ?? DEFAULTS.delayMs, 0, 5000);
      log("speak:", JSON.stringify(sanitized), "delay=" + delay);
      if (delay > 0) {
        window.setTimeout(() => dispatch(), delay);
      } else {
        dispatch();
      }
    },
    [
      prefs?.rate,
      prefs?.pitch,
      prefs?.voice,
      prefs?.voiceLang,
      prefs?.volume,
      prefs?.delayMs,
      log,
    ],
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
      resetPreGameFingerprints(fingerprints);
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

    // Pre-game scouting card fires whenever an opponent name is
    // present without a result — that's the "match starting / about
    // to start" window in the live payload.
    const hasOpp = !!live.oppName && !live.result;
    if (hasOpp) {
      if (wantsScouting && consumeFingerprint(fingerprints.scouting, scoutingFingerprint(live))) {
        const line = buildScoutingLine(live);
        if (line) lines.push(line);
      }
      if (events.matchStart && consumeFingerprint(fingerprints.matchStart, matchStartFingerprint(live))) {
        lines.push("Match starting.");
      }
    }

    if (
      events.matchEnd
      && live.result
      && consumeFingerprint(fingerprints.matchEnd, matchEndFingerprint(live))
    ) {
      lines.push(buildMatchEndLine(live));
    }

    if (
      events.cheese
      && typeof live.cheeseProbability === "number"
      && live.cheeseProbability >= 0.4
      && consumeFingerprint(fingerprints.cheese, cheeseFingerprint(live))
    ) {
      lines.push(buildCheeseLine(live));
    }

    const text = lines.join(" ").trim();
    if (text) {
      log("payload triggered readout:", JSON.stringify(text));
      enqueueOrSpeak(text);
    } else {
      log("payload produced no readout", { hasOpp, result: live.result });
    }
  }, [live, enabled, prefs, enqueueOrSpeak, log]);

  // Live-envelope match transitions: wipe per-gameKey state AND the
  // post-game fingerprint refs whenever the bridge clears a previously-
  // observed envelope OR the current envelope's ``gameKey`` flips to a
  // fresh match. Without the wipe, an old ``entry.spoken = true`` from
  // game N can silence game N+1's scouting line — most visibly on
  // rematches against the same opponent where the agent's envelope
  // lacks a ``gameKey`` and the fallback ``live:${oppName}`` key
  // collides.
  //
  // ``hadLiveGameRef`` distinguishes "initial mount, liveGame was never
  // set" from "envelope cleared from a real, previously-non-null
  // value". The distinction matters because the post-game payload
  // effect ABOVE has already stamped its dedup fingerprints by the
  // time this effect runs on mount; an unconditional wipe would erase
  // those keys and cause the next render (rerender with new ``live``
  // ref, or post-gesture replay) to re-fire the same line.
  const hadLiveGameRef = useRef<boolean>(false);
  useEffect(() => {
    const states = liveGameStates.current;
    const wipe = () => {
      clearAllLiveGameTimers(states);
      resetScoutingFingerprints(fingerprints);
    };
    if (!liveGame) {
      // Only treat this as a "bridge cleared" event when we'd
      // previously seen a non-null envelope. Initial mount with no
      // envelope is a no-op — nothing to wipe and, crucially, no
      // dedup keys to invalidate behind the payload effect's back.
      if (hadLiveGameRef.current) wipe();
      hadLiveGameRef.current = false;
      lastLiveGameKeyRef.current = null;
      return;
    }
    hadLiveGameRef.current = true;
    const lgKey = liveGame.gameKey ?? null;
    const prevKey = lastLiveGameKeyRef.current;
    if (lgKey !== null && prevKey !== null && lgKey !== prevKey) {
      // gameKey flipped — old entries are stale even if the bridge
      // never sent a null envelope in between (fast loading screen).
      wipe();
    }
    if (lgKey !== null) lastLiveGameKeyRef.current = lgKey;
  }, [liveGame, fingerprints]);

  // Pre-game / in-game readout, driven by the desktop agent's
  // ``LiveGameEnvelope`` rather than the post-game ``LiveGamePayload``.
  // Speaks at most once per ``gameKey`` AFTER enrichment lands — or
  // after the relevant fallback timeout if enrichment hasn't arrived
  // yet — so the streamer never hears half a sentence and never hears
  // the readout twice for the same match.
  //
  // Why the timeouts exist: the broker's partial-then-enriched fan-out
  // is normally fast (<300 ms), but a Pulse / Mongo blip — or a first-
  // meeting cold path that forces the full three-tier opponents lookup
  // — could leave the readout waiting on data that never lands. The
  // per-signal fallback windows (``ENRICHMENT_FALLBACK_WAIT_MS`` /
  // ``MMR_FALLBACK_WAIT_MS``) cap that wait so the readout still fires
  // with whatever data we have instead of going silent.
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
      // Bridge cleared back to menu — drop all per-gameKey state so
      // the next match-loading envelope starts fresh.
      clearAllLiveGameTimers(states);
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
      // First envelope for this gameKey. Any OTHER entries in the map
      // are from previous matches we never got a transition signal for
      // (e.g., agent crashed mid-game, broker dropped the IDLE
      // envelope) — wipe them so they can't somehow shadow this one
      // and so the map stays bounded across a long stream session.
      if (states.size > 0) clearAllLiveGameTimers(states);
      entry = { spoken: false, timer: null };
      states.set(gameKey, entry);
    }
    if (entry.spoken) return;

    // We wait for BOTH the cloud's enrichment (``streamerHistory``)
    // AND at least one usable MMR source before firing. Without that
    // the voice can speak the moment ``streamerHistory`` lands while
    // Pulse is still a few hundred ms behind, silently dropping the
    // MMR clause from the readout. The per-signal fallback timers
    // below still fire the line with whatever data we have if the
    // readiness signals never both arrive.
    const hasEnrichment = !!liveGame.streamerHistory;
    const hasMmr = isLiveGameMmrReady(liveGame);

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

    if (hasEnrichment && hasMmr) {
      // Both readiness signals landed — speak now and cancel the
      // pending fallback timer.
      if (entry.timer !== null) {
        window.clearTimeout(entry.timer);
        entry.timer = null;
      }
      fireUtterance();
      return;
    }

    // One or both signals still pending. Arm a fallback timer once
    // per gameKey so a Pulse outage / Mongo blip / first-meeting cold
    // path can't gag the readout forever — we fire with whatever
    // data we have by the deadline. The window depends on WHICH
    // signal is missing: enrichment (cloud Mongo) gets a longer
    // window than MMR (Pulse HTTP), because the cloud's three-tier
    // opponents lookup for a brand-new opponent can legitimately
    // exceed a second — and silently dropping "First meeting." /
    // the H2H clause on a fresh opponent is the regression we hit
    // pre-fix (2026-05-12 stream repro).
    const waitMs = hasEnrichment
      ? MMR_FALLBACK_WAIT_MS
      : ENRICHMENT_FALLBACK_WAIT_MS;
    if (entry.timer === null) {
      entry.timer = window.setTimeout(() => {
        const slot = states.get(gameKey);
        if (slot) slot.timer = null;
        fireUtterance();
      }, waitMs);
    }
  }, [liveGame, live, enabled, prefs, enqueueOrSpeak, log]);

  // Drain pending live-game timers on unmount so a Browser Source
  // refresh doesn't leave orphaned setTimeouts attached to a torn-down
  // hook instance.
  useEffect(() => {
    const states = liveGameStates.current;
    return () => clearAllLiveGameTimers(states);
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
      speakRequestRef.current += 1;
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
 * Internals.
 * ============================================================ */

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Resolve the streamer's voice selection against the catalog the
 * CURRENT runtime actually exposes. Returns the matched voice (or a
 * same-language fallback) alongside whether the catalog was still empty,
 * so the caller can tell "engine hasn't loaded its voices yet" (worth a
 * short retry) apart from "this voice just isn't installed here"
 * (retrying can't help — the OBS / Streamlabs CEF case).
 */
function resolvePreferredVoice(
  synth: SpeechSynthesis,
  voicesRef: MutableRefObject<SpeechSynthesisVoice[]>,
  wantedVoice: string | undefined,
  wantedLang: string | undefined,
): { voice: SpeechSynthesisVoice | null; catalogEmpty: boolean } {
  const latest = synth.getVoices();
  if (latest.length > 0) voicesRef.current = latest;
  const catalog = latest.length > 0 ? latest : voicesRef.current;
  const catalogEmpty = catalog.length === 0;
  if (!wantedVoice && !wantedLang) return { voice: null, catalogEmpty };
  return { voice: findVoice(catalog, wantedVoice, wantedLang), catalogEmpty };
}

/**
 * Find the best voice for the streamer's selection in the given
 * catalog. Tries, in order:
 *
 *   1. Exact ``name`` match — the happy path, when Settings and the
 *      overlay happen to share the same voice set.
 *   2. Case / whitespace-insensitive ``name`` match — guards against
 *      trivial label drift between engines.
 *   3. Same-language fallback — when the named voice isn't installed in
 *      THIS runtime at all. The streamer almost always picked the voice
 *      in their desktop Chrome (where the "Google …" cloud voices live),
 *      but the overlay speaks from inside OBS / Streamlabs' embedded
 *      Chromium (CEF), which ships only the local OS voices ("Microsoft
 *      …" on Windows). Rather than silently dropping to whatever the
 *      engine default is — which on a non-English OS can be the wrong
 *      language entirely — we pick the closest voice in the selection's
 *      language so the readout still sounds right.
 *
 * Returns ``null`` only when even the language is unknown / unmatched,
 * leaving the utterance on the engine default (the legacy behaviour).
 */
function findVoice(
  voices: SpeechSynthesisVoice[],
  wantedVoice: string | undefined,
  wantedLang: string | undefined,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  if (wantedVoice) {
    const exact = voices.find((v) => v.name === wantedVoice);
    if (exact) return exact;
    const wanted = normalizeVoiceName(wantedVoice);
    const normalized = voices.find(
      (v) => normalizeVoiceName(v.name) === wanted,
    );
    if (normalized) return normalized;
  }
  const lang = wantedLang || inferLangFromVoiceName(wantedVoice);
  return pickVoiceByLang(voices, lang);
}

function normalizeVoiceName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLang(lang: string | undefined | null): string {
  return (lang || "").trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Pick the best available voice for a BCP-47 language tag. Prefers an
 * exact locale match (``en-US``), then any voice sharing the base
 * language (``en``). Within a tier it favours the engine default, then a
 * local (non-network) voice — both more reliable inside CEF — then the
 * first entry. Returns ``null`` when nothing matches the language.
 */
function pickVoiceByLang(
  voices: SpeechSynthesisVoice[],
  lang: string | null,
): SpeechSynthesisVoice | null {
  const target = normalizeLang(lang);
  if (!target) return null;
  const base = target.split("-")[0];
  const exact = voices.filter((v) => normalizeLang(v.lang) === target);
  const sameBase = voices.filter(
    (v) => normalizeLang(v.lang).split("-")[0] === base,
  );
  const pool = exact.length > 0 ? exact : sameBase;
  if (pool.length === 0) return null;
  return (
    pool.find((v) => v.default) ?? pool.find((v) => v.localService) ?? pool[0]
  );
}

/**
 * Best-effort language inference from a voice NAME, for prefs saved
 * before ``voiceLang`` was captured. Covers the common Chrome / Edge /
 * Windows English voice labels (the dominant case — "Google US English",
 * "Microsoft Zira - English (United States)", …). Returns ``null`` when
 * the language can't be inferred so the caller leaves the engine default
 * untouched.
 */
function inferLangFromVoiceName(name: string | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/\ben-gb\b|uk english|british|english \(united kingdom\)|\(uk\)/.test(n)) {
    return "en-GB";
  }
  if (/\ben-us\b|us english|english \(united states\)|\(us\)/.test(n)) {
    return "en-US";
  }
  if (/\ben-au\b|australian|english \(australia\)/.test(n)) return "en-AU";
  if (/\ben-in\b|indian|english \(india\)/.test(n)) return "en-IN";
  if (/\ben-ca\b|english \(canada\)/.test(n)) return "en-CA";
  if (/\benglish\b|\ben-[a-z]{2}\b/.test(n)) return "en";
  return null;
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
