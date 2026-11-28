"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { formatNumber } from "@/lib/i18n/format";
import { ANY_FILTERS, DEFAULT_FILTERS, sameFilters, type LadderFilters } from "@/lib/ladder/vods";
import { LadderVodCard } from "./LadderVodCard";
import { LadderVodFilters } from "./LadderVodFilters";
import { useLadderVods, type Applied, type Ready } from "./useLadderVods";

const GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";
const PANEL = "space-y-3 rounded-xl border border-line bg-bg-surface p-4";

/** Cards the shape of the real ones (two text lines and the channel line), so nothing moves when games arrive. */
function LoadingResults() {
  return (
    <SkeletonRegion label="Searching ladder games" className="space-y-4">
      <div className="flex h-5 items-center"><SkeletonBar className="h-3 w-40" /></div>
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonCard key={index} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <SkeletonBar className="h-7 w-40" />
              <SkeletonBar className="h-4 w-16" />
            </div>
            <SkeletonBar className="h-4 w-52 max-w-full" />
            <SkeletonBar className="h-6 w-44 max-w-full" />
          </SkeletonCard>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** The gate-off page: the explanation first and no form, since a search that cannot run is only noise. */
function ClosedNotice() {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-5 sm:p-6">
      <p role="status" className="font-display text-body-lg font-semibold text-text">The ladder VOD finder is not available yet.</p>
      <p className="max-w-prose text-body text-text-muted">It opens once SC2Pulse, the source of these games, has agreed to this use. Until then, see who is live right now.</p>
      <Link href="/live" className={buttonClassName({ variant: "primary", size: "lg" })}>Live streams</Link>
    </div>
  );
}

function ErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={PANEL}>
      <p role="status" className="text-body text-text-muted">The ladder game search is unavailable right now. Try again in a moment.</p>
      <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={onRetry}>Retry search</button>
    </div>
  );
}

function EmptyResults({ filtered, onAny }: { filtered: boolean; onAny: () => void }) {
  return (
    <div className={PANEL}>
      <p role="status" className="max-w-prose text-body text-text-muted">
        {filtered
          ? "No recent ladder game with a Twitch VOD matches these filters. Try a wider rating or length, or any map."
          : "No recent ladder game with a Twitch VOD was found. Try again later."}
      </p>
      {filtered && <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={onAny}>Search any game</button>}
    </div>
  );
}

type ReadyProps = { state: Ready; filtered: boolean; onAny: () => void; onMore: () => Promise<boolean> };

function ReadyResults({ state, filtered, onAny, onMore }: ReadyProps) {
  const summary = useRef<HTMLParagraphElement>(null);
  const count = state.results.length;
  /** The button leaves the page with the last games, so focus moves to the count line instead of the page top. */
  const more = async () => {
    if (!(await onMore())) summary.current?.focus();
  };
  if (count === 0) return <EmptyResults filtered={filtered} onAny={onAny} />;
  return (
    <div className="space-y-4">
      <p ref={summary} tabIndex={-1} role="status" className="rounded-sm text-caption text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {formatNumber(count)} recent {count === 1 ? "game" : "games"} with a VOD{state.next ? "" : " · that is all for this search"}
      </p>
      <ul className={GRID}>
        {state.results.map(vod => <LadderVodCard key={vod.vodUrl} vod={vod} now={state.now} />)}
      </ul>
      {state.more === "error" && <p role="status" className="text-caption text-danger">More games could not be loaded.</p>}
      {state.next && (
        <button type="button" className={buttonClassName({ variant: "secondary", size: "lg" })} disabled={state.more === "loading"} onClick={more}>
          {state.more === "loading" ? "Loading…" : state.more === "error" ? "Try again" : "Show more games"}
        </button>
      )}
    </div>
  );
}

/** `closed`: the server said, when it built the page, that the finder is not open yet. */
export function LadderVods({ closed = false }: { closed?: boolean }) {
  const [draft, setDraft] = useState<LadderFilters>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<Applied>({ filters: DEFAULT_FILTERS, run: 0 });
  const { state, maps, retry, loadMore } = useLadderVods(applied, closed);
  const region = useRef<HTMLDivElement>(null);
  const searchFor = (filters: LadderFilters) => setApplied(previous => ({ filters, run: previous.run + 1 }));
  const searchAny = () => { setDraft(ANY_FILTERS); searchFor(ANY_FILTERS); };
  /** The retry button is replaced by the skeleton, so focus waits on the region that stays. */
  const onRetry = () => { retry(); region.current?.focus(); };
  if (state.kind === "closed") return <ClosedNotice />;
  return (
    <div className="space-y-4">
      <LadderVodFilters filters={draft} maps={maps} onChange={setDraft} onSearch={() => searchFor(draft)} />
      <div ref={region} tabIndex={-1} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {state.kind === "loading" && <LoadingResults />}
        {state.kind === "error" && <ErrorNotice onRetry={onRetry} />}
        {state.kind === "ready" && (
          <ReadyResults state={state} filtered={!sameFilters(applied.filters, ANY_FILTERS)} onAny={searchAny} onMore={loadMore} />
        )}
      </div>
    </div>
  );
}
