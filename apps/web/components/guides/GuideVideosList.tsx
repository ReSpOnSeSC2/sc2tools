"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { GuideEightWorkerVideos } from "@/components/guides/GuideEightWorkerVideos";
import { GuideJsonLd } from "@/components/guides/GuideJsonLd";
import { GuideVideoActions } from "@/components/guides/GuideVideoActions";
import { GuideVideoRow } from "@/components/guides/GuideVideoRow";
import { guidePaths } from "@/components/guides/guideMetadata";
import { breadcrumbJsonLd, videoJsonLd, type GuideCrumb } from "@/components/guides/guideSeo";
import { fmtCountNoun } from "@/lib/guides/format";
import type { GuideVideo, GuideVideosPayload } from "@/lib/guides/types";
import { filterGuideVideos, parseVideoMatchup, videoMatchup, VIDEO_MATCHUPS, type VideoMatchupFilter } from "@/lib/guides/videoFilters";

const VIDEO_CRUMBS: GuideCrumb[] = [
  { name: "Guides", path: guidePaths.hub() },
  { name: "Videos", path: guidePaths.videos() },
];

const PAGE_SIZE = 24;

export function GuideVideosList({ payload, initialMatchup = "all", initialVideos }: {
  payload: GuideVideosPayload;
  initialMatchup?: VideoMatchupFilter;
  /** Already filtered on the server, so shared links render correctly before hydration. */
  initialVideos?: GuideVideo[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const observedQuery = useRef(query);
  const [matchup, setMatchup] = useState(initialMatchup);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const results = useRef<HTMLDivElement>(null);
  const focusIndex = useRef<number | null>(null);
  const filtered = initialVideos && matchup === initialMatchup && !search
    ? initialVideos : filterGuideVideos(payload.videos, matchup, search);
  const counts = new Map<VideoMatchupFilter, number>();
  for (const video of payload.videos) {
    const key = videoMatchup(video.matchup) ?? "other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Omitted fields mean an older API. Explicit nulls still form an Other group.
  const hasMatchups = payload.videos.some((video) => video.matchup !== undefined);
  const chips = ["all", ...VIDEO_MATCHUPS, "other"] as const;

  useEffect(() => {
    if (observedQuery.current === query) return;
    observedQuery.current = query;
    setMatchup(parseVideoMatchup(new URLSearchParams(query).get("matchup")));
    setLimit(PAGE_SIZE);
    focusIndex.current = null;
  }, [query]);

  useEffect(() => {
    if (focusIndex.current === null) return;
    results.current?.querySelectorAll<HTMLAnchorElement>("[data-guide-video-watch]")[focusIndex.current]?.focus();
    focusIndex.current = null;
  }, [limit]);

  function selectMatchup(next: VideoMatchupFilter) {
    setMatchup(next);
    setLimit(PAGE_SIZE);
    focusIndex.current = null;
    const updated = new URLSearchParams(query);
    if (next === "all") updated.delete("matchup");
    else updated.set("matchup", next === "other" ? next : next.toLowerCase());
    const suffix = updated.toString();
    router.replace(`${pathname}${suffix ? `?${suffix}` : ""}`, { scroll: false });
  }

  function clearFilters() {
    setSearch("");
    selectMatchup("all");
  }

  const videoObjects = [...payload.videos, ...payload.eightWorkerVideos].flatMap((video) => {
    const item = videoJsonLd(video);
    return item ? [item] : [];
  });
  return (
    <div className="space-y-8">
      <GuideJsonLd items={[breadcrumbJsonLd(VIDEO_CRUMBS), ...videoObjects]} />
      <GuideBreadcrumbs crumbs={VIDEO_CRUMBS} />
      <PageHeader
        eyebrow="Build order guides"
        title="All build order videos"
        description={`${fmtCountNoun(payload.videos.length, "video")} for the 12-worker game, newest first.`}
      />
      <div className="space-y-4">
        {hasMatchups ? <div role="group" aria-label="Filter videos by matchup" className="flex flex-wrap gap-2">
          {chips.map((chip) => {
            const count = chip === "all" ? payload.videos.length : counts.get(chip) ?? 0;
            if (!count) return null;
            return <Button key={chip} size="sm" className="min-h-11" variant={matchup === chip ? "primary" : "secondary"} aria-pressed={matchup === chip} onClick={() => selectMatchup(chip)}>
              {chip === "all" ? "All" : chip === "other" ? "Other" : chip} ({count})
            </Button>;
          })}
        </div> : null}
        <label className="block max-w-lg space-y-2 text-caption font-semibold text-text">
          <span>Search video titles</span>
          <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(PAGE_SIZE); focusIndex.current = null; }}
            className="min-h-11 w-full rounded-lg border border-border bg-bg-panel px-3 text-body text-text placeholder:text-text-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" placeholder="Search titles…" />
        </label>
        <p role="status" aria-live="polite" className="text-caption text-text-muted">
          {fmtCountNoun(filtered.length, "video")} found{filtered.length > limit ? ` · Showing ${limit}` : ""}.
        </p>
      </div>
      <div ref={results}>
      <GuideVideoRow
        id="channel"
        title="12-worker build order videos"
        videos={filtered.slice(0, limit)}
        emptyText={payload.videos.length ? "No videos match" : "No 12-worker build order videos yet. Check back for new videos."}
        actions={<GuideVideoActions channel={payload.channel} playlists={payload.playlists} />}
      />
      {filtered.length === 0 && payload.videos.length > 0 ? <Button variant="secondary" onClick={clearFilters} className="mt-4">Clear filters</Button> : null}
      {filtered.length > limit ? <Button variant="secondary" className="mt-4" onClick={() => { focusIndex.current = results.current?.querySelectorAll("[data-guide-video-watch]").length ?? 0; setLimit(limit + PAGE_SIZE); }}>
        Show more ({filtered.length - limit} left)
      </Button> : null}
      </div>
      <GuideEightWorkerVideos
        videos={payload.eightWorkerVideos}
        playlistUrl={payload.playlists?.eightWorker}
      />
    </div>
  );
}
