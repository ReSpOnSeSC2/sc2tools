"use client";

/**
 * Build-order randomizer overlay widget.
 *
 * Triggers once per new gameKey: derives the matchup from whatever
 * source has it (the agent's current envelope or a legacy pre-game
 * payload), then plays the matchup's draw: a weighted-random build from
 * the user's curated pool and its reveal, the opening units after it, or
 * the opening units alone, each behind its own switch.
 *
 * A streamer who queued Random gets the draw for the race the live game
 * reports for them once the client reveals it; nothing is drawn before.
 *
 * Test fires (`overlay:live` with `isTest: true`) also drive a spin —
 * the test payload always carries a matchup so the streamer can preview
 * the reveal without queuing a real ladder game.
 *
 * Build check-in gates real games (never Test fires): the spin waits
 * briefly for the server's check-in state, never runs while a declared
 * build suppresses the build draw, and holds until the check-in hold ends
 * or the match starts. A declaration that lands after a build reveal began
 * hides it; units drawn alone hold for whatever build is played. Each real
 * spin is reported through `onSpin` the moment it starts.
 */
import { useEffect, useRef, useState } from "react";
import { coerceRace, type Race } from "@/lib/race";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  RandomizerIntentGate,
  RandomizerSpinEvent,
} from "@/components/overlay/types";
import type {
  GameDraw,
  MatchupConfig,
  MatchupKey,
  RandomizerConfig,
  RandomizerBuild,
} from "@/lib/randomizer/types";
import { MATCHUPS, isMatchupKey, playedRace } from "@/lib/randomizer/types";
import { matchupDraws } from "@/lib/randomizer/config";
import { drawGame, mulberry32, seedFromString } from "@/lib/randomizer/engine";
import { RandomizerSequence, loadUnitStage } from "@/components/randomizer/RandomizerSequence";
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
  draw: GameDraw;
  spinId: number;
  triggerKey: string;
}

type SavedPick = RandomizerIntentGate["randomizer"] | null | undefined;

/** What one game would draw now, or null when nothing is due. */
interface SpinPlan {
  config: MatchupConfig;
  /** The server's saved pick, while the matchup draws a build. */
  pick: SavedPick;
  /** A declared build suppresses the build draw, never units drawn alone. */
  suppressible: boolean;
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
  const displayedPick = spin?.triggerKey === triggerKey ? spin.draw.build?.winner.id ?? null : null;
  const intentSeen = gate?.seen ?? false;
  const suppressed = gate?.suppressRandomizer ?? false;
  const holdDeadlineMs = gate?.holdDeadlineMs ?? 0;
  const phase = liveGame?.phase ?? null;

  useEffect(() => {
    onSpinRef.current = onSpin;
  }, [onSpin]);

  // Load the unit reveal while games are pending so it plays at once.
  const drawsUnits = !!config && MATCHUPS.some((m) => config.matchups[m]?.unitRandomizerEnabled);
  useEffect(() => {
    if (drawsUnits) void loadUnitStage();
  }, [drawsUnits]);

  // Mirror the streamer's sound preference into the audio engine.
  useEffect(() => {
    if (!config) return;
    setRevealSoundEnabled(config.sound.enabled);
    setRevealSoundVolume(config.sound.volume);
  }, [config]);

  useEffect(() => {
    if (!visible || !matchup || !config || !spinKey || !triggerKey) return;
    const plan = dueSpin(config.matchups[matchup], savedPick, consumedStarts.current.has(triggerKey), displayedPick);
    if (!plan) return;
    const gateState = { seen: intentSeen, suppressRandomizer: plan.suppressible && suppressed, holdDeadlineMs };
    const delay = gateDelayMs(isTest, eligibleSince, triggerKey, gateState, phase);
    if (delay === null) return;
    if (delay > 0) {
      const handle = window.setTimeout(() => setGateClock((n) => n + 1), delay);
      return () => window.clearTimeout(handle);
    }
    const draw = gameSpin(matchup, plan.config, spinKey, plan.pick);
    if (!draw) return;
    consumedStarts.current.add(triggerKey);
    spinIdRef.current += 1;
    setSpin({ draw, spinId: spinIdRef.current, triggerKey });
    onSpinRef.current?.({ triggerKey, startedAtMs: Date.now(), roll: rollReport(gameKey, plan, draw) });
  }, [
    visible, matchup, spinKey, triggerKey, config, isTest, gameKey,
    intentSeen, suppressed, holdDeadlineMs, phase, gateClock, savedPick, displayedPick,
  ]);

  // A declaration that lands after the build reveal began takes it off stream
  // for good: replaying a half-played reveal on an undeclare would be worse.
  const spinGameKey = spin ? gameKeyFromTriggerKey(spin.triggerKey) : null;
  const spinSuppressed = !!spin && spin.draw.build !== null && spinGameKey !== null
    && intent?.gameKey === spinGameKey && intent.suppressRandomizer;
  const spinDisabled = !!spin && !!config && !stillDrawn(spin.draw, config.matchups[spin.draw.matchup]);
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
        draw={spin.draw}
        spinId={spin.spinId}
      />
    </div>
  );
}

function drawsAnything(config: MatchupConfig | undefined): boolean {
  if (!config) return false;
  const draws = matchupDraws(config);
  return draws.build || draws.units;
}

/** Each part of a reveal stays on screen only while its switch is on. */
function stillDrawn(draw: GameDraw, config: MatchupConfig | undefined): boolean {
  if (!config) return false;
  return (!draw.build || matchupDraws(config).build) && (!draw.units || config.unitRandomizerEnabled);
}

/** The matchup's switches decide what is due: a saved pick only matters
 * while a build is drawn. */
function spinPlan(config: MatchupConfig | undefined, savedPick: SavedPick): SpinPlan | null {
  if (!config || !drawsAnything(config)) return null;
  const build = matchupDraws(config).build;
  return { config, pick: build ? savedPick : null, suppressible: build };
}

/** The spin due now: none when nothing is drawn, or when this start was
 * already shown and no new saved pick replaces what is on screen. */
function dueSpin(
  config: MatchupConfig | undefined,
  savedPick: SavedPick,
  startShown: boolean,
  displayedPick: string | null,
): SpinPlan | null {
  const plan = spinPlan(config, savedPick);
  if (!plan || (startShown && (!plan.pick || displayedPick === plan.pick.key))) return null;
  return plan;
}

/**
 * The check-in gate's wait for one match; Test fires never wait. The bounded
 * wait starts once the match could first spin: the server decides the hold
 * on the envelope that first carries a concrete matchup, so races that
 * arrive late must not find the wait already used up.
 */
function gateDelayMs(
  isTest: boolean,
  since: { current: { key: string; atMs: number } | null },
  triggerKey: string,
  gate: Pick<RandomizerIntentGate, "seen" | "suppressRandomizer" | "holdDeadlineMs">,
  phase: LiveGameEnvelope["phase"] | null,
): number | null {
  if (isTest) return 0;
  const now = Date.now();
  if (since.current?.key !== triggerKey) since.current = { key: triggerKey, atMs: now };
  return randomizerSpinDelayMs({ gate, phase, waitStartedAtMs: since.current.atMs, nowMs: now });
}

/** The roll the server records: the widget's own build pick only. */
function rollReport(gameKey: string | null, plan: SpinPlan, draw: GameDraw): RandomizerSpinEvent["roll"] {
  return gameKey && !plan.pick && draw.build ? { gameKey, buildId: draw.build.winner.id } : null;
}

/**
 * The draw for one spin key. A saved pick wins and keeps its pool entry's
 * opening-unit settings. Game-key seeding keeps the build and units
 * identical if the same overlay is refreshed or rendered by both the
 * composite and dedicated Browser Sources, and lets the desktop loading
 * card show the same units (agent `build_checkin/randomizer_draw.py`,
 * pinned by `lib/randomizer/__tests__/unitDrawParity.json`). Test fires
 * carry a unique nonce so every click still produces a fresh outcome.
 */
export function gameSpin(
  matchup: MatchupKey,
  config: MatchupConfig,
  spinKey: string,
  savedPick: SavedPick,
): GameDraw | null {
  const configuredWinner = savedPick ? config.builds.find((build) => build.id === savedPick.key) : null;
  const winner: RandomizerBuild | undefined = savedPick ? {
    ...configuredWinner, id: savedPick.key, name: savedPick.name, source: savedPick.source,
    race: playedRace(matchup), weight: configuredWinner?.weight ?? 1,
  } : undefined;
  return drawGame(matchup, config, mulberry32(seedFromString(spinKey)), undefined, winner);
}

/**
 * The race the live game reports for the streamer. One who queued Random
 * keeps "Random" on `user.race` all game (Ghost needs the choice), while
 * the client's own player list reveals the race they got.
 */
export function streamerRace(liveGame: LiveGameEnvelope, fallback?: string | null): Race {
  const selected = coerceRace(liveGame.user?.race || fallback);
  if (selected !== "Random") return selected;
  const name = liveGame.user?.name;
  const mine = (liveGame.players ?? []).filter((player) => player.type === "user" && !!name && player.name === name);
  return mine.length === 1 ? coerceRace(mine[0].race) : "Random";
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
  const my = fromEnvelope ? streamerRace(liveGame, payload?.myRace) : coerceRace(payload?.myRace);
  const oppRace = fromEnvelope ? liveGame.opponent?.race || payload?.oppRace : payload?.oppRace;
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
