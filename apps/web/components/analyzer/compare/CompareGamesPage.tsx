"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { resultLabel } from "@/components/analyzer/game/types";
import { compareHref } from "@/lib/compareGameLinks";
import { formatClock } from "@/lib/replayHud";
import { useCompareSide, type CompareSide } from "./useCompareSide";
import { CompareTimelines } from "./CompareTimelines";
import { BuildOrderDiff } from "./BuildOrderDiff";
import { MechanicsCompare } from "./MechanicsCompare";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export const SIDE_NAMES = { a: "Game A", b: "Game B" } as const;

function matchup(side: CompareSide): string | null {
  const me = side.game?.myRace?.charAt(0).toUpperCase();
  const opp = side.game?.opponent?.race?.charAt(0).toUpperCase();
  return me && opp ? `${me}v${opp}` : null;
}

function SideCard({ label, side }: { label: "A" | "B"; side: CompareSide }) {
  const game = side.game;
  return (
    <Card className="min-w-0" data-testid={`compare-side-${label.toLowerCase()}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 font-display text-body font-bold ${label === "A" ? "border-accent text-accent" : "border-dashed border-text-muted text-text-muted"}`}>{label}</span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="sr-only">{SIDE_NAMES[label === "A" ? "a" : "b"]}</h2>
          {side.gameState === "loading" ? <Skeleton rows={2} /> : null}
          {side.gameState === "missing" ? (
            <p className="text-caption text-text-muted">{side.id ? "This game isn't in your synced history." : "No game chosen for this side."}</p>
          ) : null}
          {side.gameState === "error" ? <RequestError title="Couldn't load this game" error={side.gameError} onRetry={side.retryGame} /> : null}
          {game ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge variant={resultLabel(game.result) === "Win" ? "success" : resultLabel(game.result) === "Loss" ? "danger" : "neutral"} size="sm">{resultLabel(game.result)}</Badge>
                <span className="text-body font-semibold text-text">{[matchup(side), game.map].filter(Boolean).join(" · ") || "Game"}</span>
              </div>
              <p className="text-caption text-text-muted">
                {[game.date ? DATE.format(new Date(game.date)) : null, typeof game.durationSec === "number" ? formatClock(game.durationSec) : null,
                  game.opponent?.displayName ? `vs ${game.opponent.displayName}` : null].filter(Boolean).join(" · ")}
              </p>
              {game.myBuild ? <p className="truncate text-caption text-text">Build: {game.myBuild}</p> : null}
              <Link prefetch={false} href={`/app/game/${encodeURIComponent(game.gameId)}`} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                Open game {label}
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * /app/compare?a=&b= — two of your games on one clock: a dual header,
 * synced workers / army / income / supply timelines, the build-order
 * diff and mechanics side by side. Each side loads and fails on its
 * own; a game without a breakdown or build order hides only its part.
 */
export function CompareGamesPage({ a, b }: { a: string | null; b: string | null }) {
  const router = useRouter();
  const left = useCompareSide(a);
  const right = useCompareSide(b);
  const ready = !!a && !!b;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-display text-h2 font-bold text-text">
            <GitCompareArrows className="h-6 w-6 shrink-0 text-accent" aria-hidden />Compare two games
          </h1>
          <p className="mt-1 text-caption text-text-muted">Game A is drawn solid, game B dashed. Deltas read A minus B. <LazyHelpLink slug="compare-games">Help</LazyHelpLink></p>
        </div>
        {ready ? (
          <Button variant="secondary" size="sm" className="min-h-11" iconLeft={<ArrowLeftRight className="h-4 w-4" aria-hidden />}
            onClick={() => router.replace(compareHref(b, a), { scroll: false })}>
            Swap A and B
          </Button>
        ) : null}
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <SideCard label="A" side={left} />
        <SideCard label="B" side={right} />
      </div>

      {!ready ? (
        <Card>
          <EmptyStatePanel
            size="sm"
            title="Choose two games"
            description="Open a game and press Compare…, or select two replays in Replays and press Compare."
            action={<Link href="/app/replays" className="inline-flex min-h-11 items-center rounded-full border border-border px-4 text-caption font-semibold text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Go to Replays</Link>}
          />
        </Card>
      ) : a === b ? (
        <Card><p className="text-caption text-text-muted">Both sides are the same game. Pick a different game for one side to see differences.</p></Card>
      ) : (
        <>
          <CompareTimelines a={left} b={right} />
          <BuildOrderDiff a={left} b={right} />
          <MechanicsCompare a={left} b={right} />
        </>
      )}
    </div>
  );
}
