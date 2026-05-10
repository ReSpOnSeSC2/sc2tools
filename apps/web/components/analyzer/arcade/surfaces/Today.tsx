"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { useDailySeed } from "../hooks/useDailySeed";
import { useArcadeState } from "../hooks/useArcadeState";
import { ALL_MODES, GAMES, QUIZZES } from "../modes";
import { ModeRunner } from "../ModeRunner";
import { StreakHUD } from "../hud/StreakHUD";
import { XpBar } from "../hud/XpBar";
import { MascotCorner } from "../hud/MascotCorner";

/**
 * Today — the daily landing surface. Picks one quiz + one game from
 * the 16-mode catalog deterministically by daily seed, so every device
 * sees the same daily pair for the signed-in user.
 */
export function TodaySurface() {
  const seed = useDailySeed();
  const { state } = useArcadeState();
  const dailyQuiz = useMemo(
    () => QUIZZES[Math.floor(seed.rng() * QUIZZES.length)] ?? ALL_MODES[0],
    [seed.rng],
  );
  // Re-roll the rng once so the second pick is independent.
  const dailyGame = useMemo(() => {
    const r = seed.rng();
    return GAMES[Math.floor(r * GAMES.length)] ?? GAMES[0];
  }, [seed.rng]);

  return (
    <div className="relative space-y-5">
      <Card variant="feature">
        <div className="flex flex-wrap items-center gap-3">
          <StreakHUD streak={state.streak.count} />
          <XpBar xp={state.xp.total} level={state.xp.level} />
          <span className="ml-auto rounded-full border border-border bg-bg-elevated px-2.5 py-0.5 text-caption text-text-muted">
            💎 <span className="font-mono tabular-nums text-text">{state.minerals}</span>
          </span>
        </div>
      </Card>

      <section aria-label="Daily Drop" className="space-y-2">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          Daily Drop · Quiz
        </h2>
        <ModeRunner mode={dailyQuiz} isDaily />
      </section>

      <section aria-label="Daily Run" className="space-y-2">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          Daily Run · Game
        </h2>
        <ModeRunner mode={dailyGame} isDaily />
      </section>

      <MascotCorner skin={state.cosmetics.mascotSkin} played={!!state.streak.lastPlayedDay} />
    </div>
  );
}
