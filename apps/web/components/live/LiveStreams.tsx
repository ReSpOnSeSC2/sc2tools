"use client";

import { useEffect, useRef, useState } from "react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { formatTime } from "@/lib/i18n/format";
import {
  applyFilters,
  DEFAULT_FILTERS,
  degradedPlatforms,
  languagesIn,
  listedPlatforms,
  listingIsOff,
  loadLiveStreams,
  platformList,
  reconcileFilters,
  type LiveFilters,
  type LiveStreamsSnapshot,
} from "@/lib/live/streams";
import { LiveStreamCard } from "./LiveStreamCard";
import { LiveStreamFilters } from "./LiveStreamFilters";

/** The server refreshes its copy about once a minute; asking more often changes nothing. */
const REFRESH_MS = 60_000;
const GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";
const PANEL = "space-y-3 rounded-xl border border-line bg-bg-surface p-4";
const NO_FILTER = () => undefined;
type State = { kind: "loading" } | { kind: "ready"; snapshot: LiveStreamsSnapshot } | { kind: "unavailable" };

/** Loads the list, then reloads it each minute while the tab is visible; a failed reload keeps the last list. */
function useLiveStreams() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    const load = () => loadLiveStreams(request.signal).then(
      snapshot => { if (!request.signal.aborted) setState({ kind: "ready", snapshot }); },
      () => { if (!request.signal.aborted) setState(previous => (previous.kind === "ready" ? previous : { kind: "unavailable" })); },
    );
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { request.abort(); window.clearInterval(timer); };
  }, [attempt]);
  const retry = () => { setState({ kind: "loading" }); setAttempt(previous => previous + 1); };
  return { state, retry };
}

function LoadingStreams() {
  return (
    <SkeletonRegion label="Loading live streams" className="space-y-4">
      <div aria-hidden>
        <LiveStreamFilters filters={DEFAULT_FILTERS} languages={[]} streams={[]} onChange={NO_FILTER} disabled />
      </div>
      <div className="flex h-5 items-center"><SkeletonBar className="h-3 w-48" /></div>
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonCard key={index} className="space-y-2">
            <SkeletonBar className="h-6 w-40" />
            <SkeletonBar className="h-12 w-full" />
            <SkeletonBar className="h-5 w-28" />
          </SkeletonCard>
        ))}
      </div>
    </SkeletonRegion>
  );
}

function UnavailableStreams({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={PANEL}>
      <p role="status" className="text-body text-text-muted">The live stream list is unavailable right now. Try again in a moment.</p>
      <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={onRetry}>Retry live streams</button>
    </div>
  );
}

function EmptyStreams({ snapshot, filtered, onReset }: { snapshot: LiveStreamsSnapshot; filtered: boolean; onReset: () => void }) {
  if (filtered) {
    return (
      <div className={PANEL}>
        <p role="status" className="text-body text-text-muted">No live streams match these filters.</p>
        <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={onReset}>Show all streams</button>
      </div>
    );
  }
  const listed = listedPlatforms(snapshot.platforms);
  const message = listingIsOff(snapshot.platforms)
    ? "Live listings are not switched on for this site yet."
    : `No StarCraft II streams are live on ${listed.length > 0 ? platformList(listed) : "Twitch or Kick"} right now. This page checks again every minute.`;
  return <div className={PANEL}><p role="status" className="text-body text-text-muted">{message}</p></div>;
}

function DegradedNotice({ platforms }: { platforms: LiveStreamsSnapshot["platforms"] }) {
  const degraded = degradedPlatforms(platforms);
  if (degraded.length === 0) return null;
  return (
    <p role="status" className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-text">
      {platformList(degraded)} could not be refreshed, so {degraded.length === 1 ? "its" : "their"} channels may be out of date or missing.
    </p>
  );
}

function ReadyStreams({ snapshot }: { snapshot: LiveStreamsSnapshot }) {
  const [chosen, setChosen] = useState<LiveFilters>(DEFAULT_FILTERS);
  const summary = useRef<HTMLParagraphElement>(null);
  const languages = languagesIn(snapshot.streams);
  const filters = reconcileFilters(chosen, languages);
  const shown = applyFilters(snapshot.streams, filters);
  /** The pressed button leaves the page, so focus moves to the count line instead of falling to the page top. */
  const reset = () => { setChosen(DEFAULT_FILTERS); summary.current?.focus(); };
  const now = Date.parse(snapshot.fetchedAt);
  const updated = formatTime(now, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="space-y-4">
      <LiveStreamFilters filters={filters} languages={languages} streams={snapshot.streams} onChange={setChosen} />
      <DegradedNotice platforms={snapshot.platforms} />
      <p ref={summary} tabIndex={-1} role="status" className="rounded-sm text-caption text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {shown.length} of {snapshot.streams.length} live {snapshot.streams.length === 1 ? "stream" : "streams"} · updated {updated}
      </p>
      {shown.length === 0 ? (
        <EmptyStreams snapshot={snapshot} filtered={snapshot.streams.length > 0} onReset={reset} />
      ) : (
        <ul className={GRID}>
          {shown.map(stream => <LiveStreamCard key={stream.id} stream={stream} now={now} />)}
        </ul>
      )}
    </div>
  );
}

export function LiveStreams() {
  const { state, retry } = useLiveStreams();
  const region = useRef<HTMLDivElement>(null);
  /** The retry button is replaced by the skeleton, so focus waits on the region that stays. */
  const onRetry = () => { retry(); region.current?.focus(); };
  return (
    <div ref={region} tabIndex={-1} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {state.kind === "loading" && <LoadingStreams />}
      {state.kind === "unavailable" && <UnavailableStreams onRetry={onRetry} />}
      {state.kind === "ready" && <ReadyStreams snapshot={state.snapshot} />}
    </div>
  );
}
