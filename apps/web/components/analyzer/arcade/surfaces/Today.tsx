"use client";

import { Card, EmptyState } from "@/components/ui/Card";
import { useArcadeData } from "../hooks/useArcadeData";
import { useArcadeState } from "../hooks/useArcadeState";
import { useEligibleDailyPicks } from "../hooks/useEligibleDailyPicks";
import { ModeRunner } from "../ModeRunner";
import { StreakHUD } from "../hud/StreakHUD";
import { XpBar } from "../hud/XpBar";
import { MascotCorner } from "../hud/MascotCorner";
import { DailyEmptyState } from "./DailyEmptyState";

/**
 * Today — the daily landing surface. Picks one quiz + one game from
 * the 16-mode catalog deterministically by daily seed, restricted to
 * modes whose generate() proves it can build a round from the user's
 * real data today. Falls back to a unified warm-up card per kind
 * when no mode is eligible — never leaks a per-mode reason up here.
 */
export function TodaySurface() {
  const { data: dataset } = useArcadeData();
  const picks = useEligibleDailyPicks(dataset);
  const { state } = useArcadeState();

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
        {picks.quiz ? (
          <ModeRunner mode={picks.quiz} isDaily forceMode />
        ) : picks.probing ? (
          <Card>
            <EmptyState title="Building round…" sub="Picking today's quiz from your data." />
          </Card>
        ) : (
          <DailyEmptyState kind="quiz" />
        )}
      </section>

      <section aria-label="Daily Run" className="space-y-2">
        <h2 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          Daily Run · Game
        </h2>
        {picks.game ? (
          <ModeRunner mode={picks.game} isDaily forceMode />
        ) : picks.probing ? (
          <Card>
            <EmptyState title="Building round…" sub="Picking today's game from your data." />
          </Card>
        ) : (
          <DailyEmptyState kind="game" />
        )}
      </section>

      <MascotCorner skin={state.cosmetics.mascotSkin} played={!!state.streak.lastPlayedDay} />
    </div>
  );
}
