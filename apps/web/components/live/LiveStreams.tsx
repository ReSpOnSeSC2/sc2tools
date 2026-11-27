"use client";

import { useEffect, useState } from "react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { formatTime } from "@/lib/i18n/format";
import {
  applyFilters,
  DEFAULT_FILTERS,
  degradedPlatforms,
  languagesIn,
  listingIsOff,
  loadLiveStreams,
  PLATFORM_NAMES,
  type LiveFilters,
  type LiveStreamsSnapshot,
} from "@/lib/live/streams";
import { LiveStreamCard } from "./LiveStreamCard";
import { LiveStreamFilters } from "./LiveStreamFilters";

/** The server refreshes its copy about once a minute; asking more often changes nothing. */
const REFRESH_MS = 60_000;
const GRID = "grid gap-3 sm:grid-cols-2 xl:grid-cols-3";
const PANEL = "space-y-3 rounded-xl border border-line bg-bg-surface p-4";
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
      <SkeletonBar className="h-40 w-full sm:h-24" />
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, index) => (
          <SkeletonCard key={index} className="space-y-3">
            <SkeletonBar className="h-5 w-32" />
            <SkeletonBar className="h-10 w-full" />
            <SkeletonBar className="h-4 w-24" />
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
  const message = listingIsOff(snapshot.platforms)
    ? "Live listings are not switched on for this site yet."
    : "No StarCraft II streams are live on Twitch or Kick right now. This page checks again every minute.";
  return <div className={PANEL}><p role="status" className="text-body text-text-muted">{message}</p></div>;
}

function DegradedNotice({ platforms }: { platforms: LiveStreamsSnapshot["platforms"] }) {
  const names = degradedPlatforms(platforms).map(key => PLATFORM_NAMES[key]);
  if (names.length === 0) return null;
  return (
    <p role="status" className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-text">
      {names.join(" and ")} could not be refreshed, so its channels may be out of date or missing.
    </p>
  );
}

function ReadyStreams({ snapshot }: { snapshot: LiveStreamsSnapshot }) {
  const [filters, setFilters] = useState<LiveFilters>(DEFAULT_FILTERS);
  const shown = applyFilters(snapshot.streams, filters);
  const now = Date.parse(snapshot.fetchedAt);
  const updated = formatTime(now, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="space-y-4">
      <LiveStreamFilters filters={filters} languages={languagesIn(snapshot.streams)} streams={snapshot.streams} onChange={setFilters} />
      <DegradedNotice platforms={snapshot.platforms} />
      <p role="status" className="text-caption text-text-muted">
        {shown.length} of {snapshot.streams.length} live {snapshot.streams.length === 1 ? "stream" : "streams"} · updated {updated}
      </p>
      {shown.length === 0 ? (
        <EmptyStreams snapshot={snapshot} filtered={snapshot.streams.length > 0} onReset={() => setFilters(DEFAULT_FILTERS)} />
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
  if (state.kind === "loading") return <LoadingStreams />;
  if (state.kind === "unavailable") return <UnavailableStreams onRetry={retry} />;
  return <ReadyStreams snapshot={state.snapshot} />;
}
