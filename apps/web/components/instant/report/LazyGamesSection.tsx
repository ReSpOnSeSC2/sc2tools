"use client";

/**
 * "Game by game" (`GamesSection`), loaded on demand with next/dynamic:
 * its build-order columns, SC2 icon tables and the macro chart loader
 * stay out of the /try page's first load, which only needs the intake.
 * It also mounts one step after the report: the cards paint first, and
 * the section (its code, the game list and both build orders) follows
 * in a separate, interruptible transition render, so neither render is
 * a long task. New report data (e.g. the games re-read once they are
 * stored on this device) reaches it the same way: a deferred value
 * behind `memo`, so an urgent re-render of the report never re-renders
 * the section — which, while its code is still arriving, would render
 * the whole game detail in one blocking pass. It sits at the bottom of
 * the report, so its placeholder never pushes the cards above it
 * around. Renders nothing without games.
 *
 * Example:
 *   <LazyGamesSection games={report.games} />
 */
import { memo, startTransition, useDeferredValue, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { GamesSectionProps } from "./GamesSection";

/**
 * Placeholder while the section's code loads (reduced motion: no pulse).
 *
 * Example:
 *   <GamesSectionSkeleton />
 */
export function GamesSectionSkeleton() {
  return (
    <div role="status" aria-label="Loading your games" className="space-y-3" data-testid="report-games-skeleton">
      <div className="h-7 w-48 rounded bg-bg-elevated" />
      <div className="h-64 w-full animate-pulse rounded-xl bg-bg-elevated motion-reduce:animate-none" />
    </div>
  );
}

const GamesSection = memo(
  dynamic(() => import("./GamesSection").then((mod) => mod.GamesSection), {
    ssr: false,
    loading: () => <GamesSectionSkeleton />,
  }),
);

/**
 * The game-by-game section, code-split and mounted after the report paints.
 *
 * Example:
 *   <LazyGamesSection games={[]} /> // renders nothing
 */
export function LazyGamesSection({ games }: GamesSectionProps) {
  const [mounted, setMounted] = useState(false);
  const shownGames = useDeferredValue(games);
  useEffect(() => startTransition(() => setMounted(true)), []);
  if (games.length === 0) return null;
  return mounted ? <GamesSection games={shownGames} /> : <GamesSectionSkeleton />;
}
