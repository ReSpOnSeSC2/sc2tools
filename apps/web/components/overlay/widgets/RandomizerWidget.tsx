"use client";

/**
 * Build-order randomizer overlay widget.
 *
 * Triggers once per new gameKey: derives the matchup from whatever
 * source has it (post-game ``live`` payload, the agent's pre/in-game
 * envelope, or a derived race pairing), spins a weighted-random build
 * from the user's curated pool, renders a build-order reveal, then follows it
 * with the winning build's configured Gateway-unit draw when enabled.
 *
 * Test fires (`overlay:live` with `isTest: true`) also drive a spin —
 * the test payload always carries a matchup so the streamer can preview
 * the reveal without queuing a real ladder game.
 */
import { useEffect, useRef, useState } from "react";
import { coerceRace } from "@/lib/race";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
} from "@/components/overlay/types";
import type {
  MatchupKey,
  RandomizerConfig,
  SpinOutcome,
} from "@/lib/randomizer/types";
import { isMatchupKey } from "@/lib/randomizer/types";
import { mulberry32, seedFromString, spinResult } from "@/lib/randomizer/engine";
import { RandomizerSequence } from "@/components/randomizer/RandomizerSequence";
import {
  setRevealSoundEnabled,
  setRevealSoundVolume,
} from "@/components/randomizer/reveals/revealSound";

interface SpinState {
  outcome: SpinOutcome;
  spinId: number;
}

export function RandomizerWidget({
  live,
  liveGame,
  config,
}: {
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  config: RandomizerConfig | null;
}) {
  const matchup = deriveMatchup(live, liveGame);
  const spinKey = deriveSpinKey(matchup, live, liveGame);
  const [spin, setSpin] = useState<SpinState | null>(null);
  const lastSpinKeyRef = useRef<string | null>(null);
  const spinIdRef = useRef(0);

  // Mirror the streamer's sound preference into the audio engine.
  useEffect(() => {
    if (!config) return;
    setRevealSoundEnabled(config.sound.enabled);
    setRevealSoundVolume(config.sound.volume);
  }, [config]);

  useEffect(() => {
    if (!matchup || !config || !spinKey) return;
    if (lastSpinKeyRef.current === spinKey) return;
    const mc = config.matchups[matchup];
    if (!mc || !mc.enabled || mc.builds.length === 0) return;
    // Game-key seeding keeps the build and unit pair identical if the same
    // overlay is refreshed or rendered by both the composite and dedicated
    // Browser Sources. Test fires carry a unique nonce so every click still
    // produces a fresh outcome.
    const outcome = spinResult(matchup, mc, mulberry32(seedFromString(spinKey)));
    if (!outcome) return;
    lastSpinKeyRef.current = spinKey;
    spinIdRef.current += 1;
    setSpin({ outcome, spinId: spinIdRef.current });
  }, [matchup, spinKey, config]);

  if (!spin) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
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

/** Pull the matchup label from whichever source has it first. */
function deriveMatchup(
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): MatchupKey | null {
  const direct = live?.matchup || liveGame?.streamerHistory?.matchup;
  if (isMatchupKey(direct)) return direct;
  const myRace = live?.myRace || liveGame?.streamerHistory?.myRace;
  const oppRace =
    live?.oppRace ||
    liveGame?.streamerHistory?.oppRace ||
    liveGame?.opponent?.race;
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
  // Test fires don't carry a gameKey — synthesise one pinned to the test
  // fire so a second Test re-triggers the widget. Checked first because a
  // sample payload may carry a ``result`` and we still want it to spin.
  if (live?.isTest) {
    return `${matchup}:test:${live.testNonce ?? live.gameKey ?? live.matchup ?? "x"}`;
  }
  // The randomizer reveals "what to build THIS game", so it must fire at
  // game START only. The agent's pre/in-game envelope is the start
  // signal — key off its gameKey, but ONLY while the match is still LIVE
  // (loading / started / in-progress). A ``match_ended`` envelope keeps
  // arriving with the SAME gameKey (the socket only nulls ``liveGame`` on
  // idle/menu), so treating it as a start signal is the game-END re-spin:
  // the mid-match visibility timer unmounts the widget — resetting the
  // spin-dedupe ref — and the lingering ended envelope (or the post-game
  // payload that remounts the widget) would otherwise spin a SECOND time
  // as the game finishes.
  const phase = liveGame?.phase;
  const envLive =
    phase === "match_loading"
    || phase === "match_started"
    || phase === "match_in_progress";
  const envKey = liveGame?.gameKey;
  if (envLive && typeof envKey === "string" && envKey.length > 0) {
    return `${matchup}:${envKey}`;
  }
  // No agent envelope (agent offline / replay-only). Only a ``live``
  // payload WITHOUT a result may start a spin: a post-game card always
  // carries a ``result``, and firing off it is the same game-END
  // double-spin. The agent gameKey and the cloud's replay-derived gameKey
  // often differ, so dedupe-by-key can't catch this.
  if (
    live
    && !live.result
    && typeof live.gameKey === "string"
    && live.gameKey.length > 0
  ) {
    return `${matchup}:${live.gameKey}`;
  }
  return null;
}
