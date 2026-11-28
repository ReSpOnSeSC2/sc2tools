"use client";

import { useRef, type ReactNode } from "react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { CARD_GRID, ProBoardSections, TILE_GRID } from "./ProBoardSections";
import { useProBoard } from "./useProBoard";

const PANEL = "space-y-3 rounded-xl border border-line bg-bg-surface p-4";

/** A heading and its note, as bars, so the sections do not move when the board arrives. */
function SectionBars({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <SkeletonBar className="h-7 w-48 max-w-full" />
        <SkeletonBar className="h-4 w-72 max-w-full" />
      </div>
      {children}
    </div>
  );
}

/** Shaped like the real board: pro cards when the server shows names, then the player tiles. */
function LoadingBoard({ names }: { names: boolean }) {
  return (
    <SkeletonRegion label="Loading the pros board" className="space-y-8">
      {names && (
        <SectionBars>
          <div className={CARD_GRID}>
            {Array.from({ length: 3 }, (_, index) => (
              <SkeletonCard key={index} className="space-y-3">
                <SkeletonBar className="h-6 w-36" />
                <SkeletonBar className="h-4 w-52 max-w-full" />
                <SkeletonBar className="h-11 w-full" />
                <SkeletonBar className="h-11 w-full" />
                <SkeletonBar className="h-11 w-full" />
              </SkeletonCard>
            ))}
          </div>
        </SectionBars>
      )}
      <SectionBars>
        <div className={TILE_GRID}>
          {Array.from({ length: 12 }, (_, index) => (
            <SkeletonCard key={index} className="space-y-1.5 !rounded-lg !p-3">
              <SkeletonBar className="h-5 w-16" />
              <SkeletonBar className="h-5 w-20" />
              <SkeletonBar className="h-4 w-14" />
            </SkeletonCard>
          ))}
        </div>
      </SectionBars>
    </SkeletonRegion>
  );
}

/** The gate-off page: the explanation first, since a board that cannot be filled is only noise. */
function ClosedNotice() {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-5 sm:p-6">
      <p role="status" className="font-display text-body-lg font-semibold text-text">Pros on Ladder is not available yet.</p>
      <p className="max-w-prose text-body text-text-muted">It opens once SC2Pulse, the source of these games, has agreed to this use. Until then, see who is live right now.</p>
      <Link href="/live" className={buttonClassName({ variant: "primary", size: "lg" })}>Live streams</Link>
    </div>
  );
}

function ErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={PANEL}>
      <p role="status" className="text-body text-text-muted">The board could not be loaded right now. Try again in a moment.</p>
      <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={onRetry}>Retry</button>
    </div>
  );
}

/**
 * `closed`: the server said, when it built the page, that the board is not
 * open yet. `names`: whether it shows pro names, so the loading state has the
 * shape of the board that will replace it.
 */
export function ProBoard({ closed = false, names = false }: { closed?: boolean; names?: boolean }) {
  const { state, retry } = useProBoard(closed);
  const region = useRef<HTMLDivElement>(null);
  /** The retry button is replaced by the skeleton, so focus waits on the region that stays. */
  const onRetry = () => { retry(); region.current?.focus(); };
  if (state.kind === "closed") return <ClosedNotice />;
  return (
    <div ref={region} tabIndex={-1} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {state.kind === "loading" && <LoadingBoard names={names} />}
      {state.kind === "error" && <ErrorNotice onRetry={onRetry} />}
      {state.kind === "ready" && <ProBoardSections board={state.board} now={state.now} />}
    </div>
  );
}
