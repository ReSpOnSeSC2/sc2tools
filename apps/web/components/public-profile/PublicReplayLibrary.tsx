import Link from "next/link";
import { ArrowLeft, ChevronRight, Download, Share2 } from "lucide-react";
import { ReplayList } from "@/components/analyzer/replays/ReplayList";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { FilterChip } from "@/components/ui/FilterChip";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { PublicReplayShareButton } from "./PublicReplayShareButton";
import { ArchiveFilterEnhancer } from "./ArchiveFilterEnhancer";
import { ArchiveSummary } from "./ArchiveSummary";
import { archiveFilterLabels, archiveHref, type PublicReplayQuery } from "./archiveQuery";

export type { PublicReplayQuery } from "./archiveQuery";
const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ", "RvP", "RvT", "RvZ"];
const pageLinkClass = "inline-flex min-h-11 items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-4 font-display text-caption font-bold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function PublicReplayLibrary({ data, query }: { data: ReplayLibraryResponse; query: PublicReplayQuery }) {
  const { profile, items, page } = data;
  const root = `/players/${encodeURIComponent(profile.handle)}/replays`;
  const chips = archiveFilterLabels(query); const hasLocalFilters = chips.length > 0;
  const matchups = Array.from(new Set([...(data.facets?.matchups?.length ? data.facets.matchups : MATCHUPS), ...(query.matchup ? [query.matchup] : [])]));
  const maps = Array.from(new Set([...(data.facets?.maps || []), ...(query.map ? [query.map] : [])]));
  const resetPage = { cursor: undefined, page: undefined };
  const knownPage = query.cursor ? query.page : 1;
  const nextPage = knownPage !== undefined && knownPage < 1000 ? knownPage + 1 : undefined;
  return <article className="space-y-6">
    <Card variant="feature" padded={false} className="relative overflow-hidden">
      <div className="absolute -right-16 -top-20 h-60 w-60 rounded-full bg-accent-cyan/12 blur-3xl" aria-hidden />
      <div className="relative p-5 sm:p-7">
        <PageHeader eyebrow={<span className="inline-flex flex-wrap items-center gap-2"><Share2 className="h-4 w-4" aria-hidden />Shared replay archive<Badge variant="cyan" size="sm">Live from synced games</Badge></span>}
          title={`${profile.displayName}'s replays`} description="Every synced game, with replay downloads and stream POVs."
          actions={<PublicReplayShareButton path={archiveHref(root, query)} playerName={profile.displayName} />} />
        <p className="mt-5 flex items-start gap-2 rounded-xl border border-border bg-bg-elevated/55 p-3 text-caption text-text-muted"><Download className="mt-0.5 h-4 w-4 flex-none text-accent-cyan" aria-hidden />Download any replay without an account · Sign in free for the full analysis</p>
      </div>
    </Card>
    {query.notice === "page-expired" ? <p role="status" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-text">That page link expired. Showing the {query.sort === "date_asc" ? "oldest" : "newest"} replays. <Link href={archiveHref(root, query)} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Dismiss</Link></p> : null}
    <Card padded={false}>
      <ArchiveFilterEnhancer key={archiveHref(root, query)} action={root} search={query.search} build={query.build}>
        <ArchiveSelect label="Result" name="result" value={query.result || ""} options={[["", "All results"], ["win", "Wins"], ["loss", "Losses"], ["tie", "Ties"]]} />
        <ArchiveSelect label="Matchup" name="matchup" value={query.matchup || ""} options={[["", "All matchups"], ...matchups.map((value) => [value, value])]} />
        <ArchiveSelect label="Map" name="map" value={query.map || ""} options={[["", "All maps"], ...maps.map((value) => [value, value])]} />
        <ArchiveSelect label="Date" name="range" value={query.range || ""} options={[["", "All time"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["season", "This season"]]} />
        <ArchiveSelect label="Order" name="sort" value={query.sort || "date_desc"} options={[["date_desc", "Newest first"], ["date_asc", "Oldest first"]]} />
      </ArchiveFilterEnhancer>
      {chips.length ? <nav aria-label="Active replay filters" className="flex flex-wrap items-center gap-2 border-b border-border p-4">{chips.map(({ key, label }) => <FilterChip key={key} label={label} href={archiveHref(root, query, { ...resetPage, [key]: undefined })} />)}{chips.length >= 2 ? <Link href={root} className="inline-flex min-h-11 items-center px-2 text-caption font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Clear all</Link> : null}</nav> : null}
      <section id="replay-results" tabIndex={-1} aria-label="Replay results" className="scroll-mt-24 focus:outline-none">
        <ArchiveSummary data={data} query={query} />
        <ReplayList items={items} owner={false} playerName={profile.displayName} publicHandle={profile.handle}
          listQuery={archiveHref("", query).replace(/^\?/, "")}
          emptyTitle={hasLocalFilters ? "No replays match these filters" : "No shared replays yet"}
          emptyDescription={hasLocalFilters ? "Clear or broaden the replay filters to see more games." : `When ${profile.displayName} syncs a replay, it will appear here automatically.`} />
      </section>
      {query.cursor || page.hasMore ? <nav aria-label="Replay pages" className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line px-4 py-3">
        {query.cursor ? <Link href={`${archiveHref(root, query, resetPage)}#replay-results`} className={pageLinkClass}><ArrowLeft className="h-4 w-4" aria-hidden />Back to {query.sort === "date_asc" ? "oldest" : "newest"}</Link> : <span />}
        {page.hasMore && page.nextCursor ? <Link href={`${archiveHref(root, query, { cursor: page.nextCursor, page: nextPage })}#replay-results`} className={pageLinkClass}>{query.sort === "date_asc" ? "Newer" : "Older"} replays<ChevronRight className="h-4 w-4" aria-hidden /></Link> : null}
      </nav> : null}
    </Card>
    <p className="text-center text-micro text-text-dim">Shared by {profile.displayName}. Anyone with this link can browse the list and download replays. Downloads are the original .SC2Replay file, which includes the in-game names and chat StarCraft II records.</p>
  </article>;
}

function ArchiveSelect({ label, name, value, options }: { label: string; name: string; value: string; options: string[][] }) {
  return <label className="min-w-0"><span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">{label}</span><Select name={name} defaultValue={value} className="min-h-11">{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</Select></label>;
}
