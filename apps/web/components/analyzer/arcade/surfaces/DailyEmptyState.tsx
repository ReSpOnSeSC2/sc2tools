"use client";

import { Card, EmptyState } from "@/components/ui/Card";

/**
 * DailyEmptyState — the unified warm-up card shown in the Today
 * surface's Daily Drop and Daily Run slots when no quiz/game in the
 * catalog can build a round from the user's real data today.
 *
 * Why a global card here instead of a per-mode reason? On Today, the
 * picker chooses which mode runs — a per-mode "Need ≥4 opponents…"
 * leaks the failed mode's gate up as the day's headline. QuickPlay
 * still surfaces the per-mode reason because the user explicitly
 * chose the failing mode there.
 */
export function DailyEmptyState({
  kind,
  helperHref = "/",
}: {
  kind: "quiz" | "game";
  helperHref?: string;
}) {
  const title = kind === "quiz" ? "Daily Drop warming up" : "Daily Run warming up";
  const sub =
    kind === "quiz"
      ? "Play a handful more games against varied opponents and your daily quiz unlocks. We never invent rounds — every Arcade question is built from your real history."
      : "Daily mini-games unlock once you have enough recent games. Keep your replay watcher running and check back tomorrow.";
  const ariaLabel =
    kind === "quiz" ? "Daily quiz unavailable" : "Daily game unavailable";
  return (
    <Card>
      <section role="region" aria-label={ariaLabel} className="space-y-3">
        <EmptyState title={title} sub={sub} />
        <div className="text-center">
          <a
            href={helperHref}
            className="inline-flex min-h-[44px] items-center rounded-md bg-accent px-4 text-caption font-semibold uppercase tracking-wider text-bg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open the analyzer →
          </a>
        </div>
      </section>
    </Card>
  );
}
