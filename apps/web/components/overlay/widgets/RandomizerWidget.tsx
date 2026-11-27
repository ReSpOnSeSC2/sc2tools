"use client";

/**
 * Build-order randomizer overlay widget.
 *
 * Triggers once per new gameKey: derives the matchup from whatever
 * source has it (the agent's current envelope or a legacy pre-game
 * payload), spins a weighted-random build
 * from the user's curated pool, renders a build-order reveal, then follows it
 * with the winning build's configured Gateway-unit draw when enabled.
 *
 * Test fires (`overlay:live` with `isTest: true`) also drive a spin —
 * the test payload always carries a matchup so the streamer can preview
 * the reveal without queuing a real ladder game.
 *
 * Build check-in gates real games (never Test fires): the spin waits
 * briefly for the server's check-in state, never runs while a declared
 * build suppresses it, and holds until the check-in hold ends or the
 * match starts. A declaration that lands after the reveal began hides
 * it. Each real spin is reported through `onSpin` the moment it starts.
 */
import { useEffect, useRef, useState } from "react";
import { coerceRace } from "@/lib/race";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  RandomizerIntentGate,
  RandomizerSpinEvent,
} from "@/components/overlay/types";
import type {
  MatchupConfig,
  MatchupKey,
  RandomizerConfig,
  RandomizerBuild,
  SpinOutcome,
} from "@/lib/randomizer/types";
import { isMatchupKey } from "@/lib/randomizer/types";
import { mulberry32, seedFromString, spinResult } from "@/lib/randomizer/engine";
import { RandomizerSequence } from "@/components/randomizer/RandomizerSequence";
import {
  gameKeyFromTriggerKey,
  isCompletedOverlayGame,
  randomizerStartTriggerKey,
  useRandomizerTriggerKey,
} from "../gameStartTrigger";
import { randomizerSpinDelayMs } from "../buildIntentGate";
import { useOverlayPlacement } from "../OverlayPlacement";
import {
  setRevealSoundEnabled,
  setRevealSoundVolume,
} from "@/components/randomizer/reveals/revealSound";

interface SpinState {
  outcome: SpinOutcome;
  spinId: number;
  triggerKey: string;
}

export function RandomizerWidget({
  live,
  liveGame,
  config,
  visible = true,
  intent = null,
  onSpin,
}: {
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  config: RandomizerConfig | null;
  visible?: boolean;
  /** Build check-in gate for the client's current match. */
  intent?: RandomizerIntentGate | null;
  /** Called once per spin, as it starts. */
  onSpin?: (spin: RandomizerSpinEvent) => void;
}) {
  const placement = useOverlayPlacement();
  const matchup = deriveMatchup(live, liveGame);
  const spinKey = deriveSpinKey(matchup, live, liveGame);
  const triggerKey = useRandomizerTriggerKey(live, liveGame);
  const [spin, setSpin] = useState<SpinState | null>(null);
  const [dismissedSpinId, setDismissedSpinId] = useState<number | null>(null);
  // Bumped by the gate's timers so the spin effect re-checks the gate.
  const [gateClock, setGateClock] = useState(0);
  const consumedStarts = useRef(new Set<string>());
  const spinIdRef = useRef(0);
  const eligibleSince = useRef<{ key: string; atMs: number } | null>(null);
  const onSpinRef = useRef(onSpin);

  const isTest = Boolean(live?.isTest);
  const gameKey = gameKeyFromTriggerKey(triggerKey);
  const gate = intent && intent.gameKey === gameKey ? intent : null;
  const savedPick = isTest ? null : gate?.randomizer;
  const displayedPick = spin?.triggerKey === triggerKey ? spin.outcome.winner.id : null;
  const intentSeen = gate?.seen ?? false;
  const suppressed = gate?.suppressRandomizer ?? false;
  const holdDeadlineMs = gate?.holdDeadlineMs ?? 0;
  const phase = liveGame?.phase ?? null;

  useEffect(() => {
    onSpinRef.current = onSpin;
  }, [onSpin]);

  // Mirror the streamer's sound preference into the audio engine.
  useEffect(() => {
    if (!config) return;
    setRevealSoundEnabled(config.sound.enabled);
    setRevealSoundVolume(config.sound.volume);
  }, [config]);

  useEffect(() => {
    if (!visible || !matchup || !config || !spinKey || !triggerKey) return;
    if (consumedStarts.current.has(triggerKey) && (!savedPick || displayedPick === savedPick.key)) return;
    const mc = config.matchups[matchup];
    if (!mc || !mc.enabled || mc.builds.length === 0) return;
    if (!isTest) {
      const now = Date.now();
      // The bounded wait starts once this match could first spin: the
      // server decides the hold on the envelope that first carries a
      // concrete matchup, so races that arrive late must not find the
      // wait already used up.
      if (eligibleSince.current?.key !== triggerKey) {
        eligibleSince.current = { key: triggerKey, atMs: now };
      }
      const delay = randomizerSpinDelayMs({
        gate: { seen: intentSeen, suppressRandomizer: suppressed, holdDeadlineMs },
        phase,
        waitStartedAtMs: eligibleSince.current.atMs,
        nowMs: now,
      });
      if (delay === null) return;
      if (delay > 0) {
        const handle = window.setTimeout(() => setGateClock((n) => n + 1), delay);
        return () => window.clearTimeout(handle);
      }
    }
    const outcome = gameSpin(matchup, mc, spinKey, savedPick);
    if (!outcome) return;
    consumedStarts.current.add(triggerKey);
    spinIdRef.current += 1;
    setSpin({ outcome, spinId: spinIdRef.current, triggerKey });
    onSpinRef.current?.({
      triggerKey,
      startedAtMs: Date.now(),
      roll: gameKey && !savedPick ? { gameKey, buildId: outcome.winner.id } : null,
    });
  }, [
    visible, matchup, spinKey, triggerKey, config, isTest, gameKey,
    intentSeen, suppressed, holdDeadlineMs, phase, gateClock, savedPick, displayedPick,
  ]);

  // A declaration that lands after the reveal began takes it off stream
  // for good: replaying a half-played reveal on an undeclare would be worse.
  const spinGameKey = spin ? gameKeyFromTriggerKey(spin.triggerKey) : null;
  const spinSuppressed = spinGameKey !== null
    && intent?.gameKey === spinGameKey
    && intent.suppressRandomizer;
  const spinDisabled = !!spin && !!config && config.matchups[spin.outcome.matchup]?.enabled !== true;
  const spinEnded = spinGameKey !== null && (
    (liveGame?.phase === "match_ended" && (!liveGame.gameKey || liveGame.gameKey === spinGameKey))
    || (live?.gameKey === spinGameKey && isCompletedOverlayGame(live))
  );
  useEffect(() => {
    if (spin && (spinSuppressed || spinDisabled || spinEnded)) setDismissedSpinId(spin.spinId);
  }, [spin, spinSuppressed, spinDisabled, spinEnded]);

  // Keep the reveal mounted through transient phase gaps; the clients hide
  // its frame. A genuinely different match must wait for its own outcome.
  if (!spin || (triggerKey !== null && spin.triggerKey !== triggerKey)) return null;
  if (spinSuppressed || spinDisabled || spinEnded || dismissedSpinId === spin.spinId) return null;

  return (
    <div
      style={{
        position: "absolute",
        ...(placement ?? { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }),
        width: "min(680px, 96vw)",
        pointerEvents: "none",
      }}
    >
      <RandomizerSequence
        key={spin.spinId}
        outcome={spin.outcome}
        spinId={spin.spinId}
      />
    </div>
  );
}

/**
 * The reveal for one spin key. A saved pick wins and keeps its pool entry's
 * opening-unit settings. Game-key seeding keeps the build and unit pair
 * identical if the same overlay is refreshed or rendered by both the composite
 * and dedicated Browser Sources, and lets the desktop loading card show the
 * same units (agent `build_checkin/randomizer_draw.py`, pinned by
 * `lib/randomizer/__tests__/unitDrawParity.json`). Test fires carry a unique
 * nonce so every click still produces a fresh outcome.
 */
export function gameSpin(
  matchup: MatchupKey,
  config: MatchupConfig,
  spinKey: string,
  savedPick: RandomizerIntentGate["randomizer"] | null,
): SpinOutcome | null {
  const configuredWinner = savedPick ? config.builds.find((build) => build.id === savedPick.key) : null;
  const winner: RandomizerBuild | undefined = savedPick ? {
    ...configuredWinner, id: savedPick.key, name: savedPick.name, source: savedPick.source,
    race: matchup[0] === "P" ? "Protoss" : matchup[0] === "T" ? "Terran" : "Zerg",
    weight: configuredWinner?.weight ?? 1,
  } : undefined;
  return spinResult(matchup, config, mulberry32(seedFromString(spinKey)), undefined, winner);
}

/** Use the current envelope; a cached live payload may belong to the last game. */
function deriveMatchup(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): MatchupKey | null {
  const fromEnvelope = !!liveGame && !live?.isTest;
  const payload = fromEnvelope ? liveGame.streamerHistory : live;
  const direct = payload?.matchup;
  if (isMatchupKey(direct)) return direct;
  const myRace = fromEnvelope ? liveGame.user?.race || payload?.myRace : payload?.myRace;
  const oppRace = fromEnvelope ? liveGame.opponent?.race || payload?.oppRace : payload?.oppRace;
  const my = coerceRace(myRace);
  const vs = coerceRace(oppRace);
  if (my === "Random" || vs === "Random") return null;
  const key = `${my[0]}v${vs[0]}`;
  return isMatchupKey(key) ? key : null;
}

/**
 * Unique key per spin moment. Real games key off the agent's stable
 * `gameKey`; test fires use the API-stamped nonce so each Test click
 * triggers a fresh spin.
 */
export function deriveSpinKey(
  matchup: MatchupKey | null,
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  if (!matchup) return null;
  const trigger = randomizerStartTriggerKey(live, liveGame);
  const seed = live?.isTest ? trigger : gameKeyFromTriggerKey(trigger);
  return seed ? `${matchup}:${seed}` : null;
}
