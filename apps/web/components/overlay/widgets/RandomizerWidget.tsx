"use client";

/**
 * Build-order randomizer overlay widget.
 *
 * Triggers once per new gameKey: derives the matchup from whatever
 * source has it (post-game ``live`` payload, the agent's pre/in-game
 * envelope, or a derived race pairing), spins a weighted-random build
 * from the user's curated pool, and renders one of the five reveal
 * animations.
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
import { spinResult } from "@/lib/randomizer/engine";
import { RandomizerStage } from "@/components/randomizer/RandomizerStage";

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

  useEffect(() => {
    if (!matchup || !config || !spinKey) return;
    if (lastSpinKeyRef.current === spinKey) return;
    const mc = config.matchups[matchup];
    if (!mc || !mc.enabled || mc.builds.length === 0) return;
    const outcome = spinResult(matchup, mc);
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
        width: "min(620px, 96vw)",
        pointerEvents: "none",
      }}
    >
      <RandomizerStage outcome={spin.outcome} spinId={spin.spinId} />
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
 * `gameKey`; test fires synthesise a key from the `live` object's
 * identity so each Test click triggers a fresh spin.
 */
function deriveSpinKey(
  matchup: MatchupKey | null,
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
): string | null {
  if (!matchup) return null;
  const liveKey = liveGame?.gameKey || live?.gameKey;
  if (typeof liveKey === "string" && liveKey.length > 0) {
    return `${matchup}:${liveKey}`;
  }
  // Test fires don't carry a gameKey — fall back to a synthetic id
  // pinned to the test fire so a second Test still re-triggers the
  // widget.
  if (live?.isTest) return `${matchup}:test:${live.matchup ?? "x"}`;
  return null;
}
