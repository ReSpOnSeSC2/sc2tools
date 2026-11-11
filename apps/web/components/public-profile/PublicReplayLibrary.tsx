import Link from "next/link";
import { PlayerSectionNav } from "./PlayerSectionNav";
import { ArrowLeft, ChevronRight, Download, Share2 } from "lucide-react";
import { ReplayList } from "@/components/analyzer/replays/ReplayList";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { FilterChip } from "@/components/ui/FilterChip";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";
import { ShareButton } from "@/components/ui/ShareButton";
import { LinkButton } from "@/components/ui/Button";
import { GlowHalo } from "@/components/ui/GlowHalo";
import { ArchiveFilterEnhancer } from "./ArchiveFilterEnhancer";
import { ArchiveSummary } from "./ArchiveSummary";
import { archiveFilterLabels, archiveHref, type PublicReplayQuery } from "./archiveQuery";

export type { PublicReplayQuery } from "./archiveQuery";
const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ", "RvP", "RvT", "RvZ"];

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
      <GlowHalo color="cyan" position="top-right" />
      <div className="relative p-5 sm:p-7">
        <PageHeader eyebrow={<span className="inline-flex flex-wrap items-center gap-2"><Share2 className="h-4 w-4" aria-hidden />Shared replay archive<Badge variant="cyan" size="sm">Live from synced games</Badge></span>}
          title={`${profile.displayName}'s replays`} description="Every synced game, with replay downloads and stream POVs."
          actions={<ShareButton path={archiveHref(root, query)} title={profile.displayName + "'s StarCraft II replays"}
            text={"View and download " + profile.displayName + "'s shared StarCraft II replays."}
            aria-label={"Share " + profile.displayName + "'s replay page"} />} />
        <p className="mt-5 flex items-start gap-2 rounded-xl border border-border bg-bg-elevated/55 p-3 text-caption text-text-muted"><Download className="mt-0.5 h-4 w-4 flex-none text-accent-cyan" aria-hidden />Download any replay without an account · Sign in free for the full analysis</p>
      </div>
    </Card>
    <PlayerSectionNav handle={profile.profileHandle || profile.handle} active="replays" sections={profile.profileHandle ? ["overview", "replays"] : ["replays"]} />
    {query.notice === "page-expired" ? <p role="status" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-text">That page link expired. Showing the {query.sort === "date_asc" ? "oldest" : "newest"} replays. <Link href={archiveHref(root, query)} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Dismiss</Link></p> : null}
    <Card padded={false}>
      <ArchiveFilterEnhancer key={archiveHref(root, query)} action={root} search={query.search} build={query.build}>
        <ArchiveSelect label="Result" name="result" value={query.result || ""} options={[["", "All results"], ["win", "Wins"], ["loss", "Losses"], ["tie", "Ties"]]} />
        <ArchiveSelect label="Matchup" name="matchup" value={query.matchup || ""} options={[["", "All matchups"], ...matchups.map((value) => [value, value])]} />
        <ArchiveSelect label="Map" name="map" value={query.map || ""} options={[["", "All maps"], ...maps.map((value) => [value, value])]} />
        <ArchiveSelect label="Date" name="range" value={query.range || ""} options={[["", "All time"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["season", "This season"]]} />
        <ArchiveSelect label="Order" name="sort" value={query.sort || "date_desc"} options={[["date_desc", "Newest first"], ["date_asc", "Oldest first"]]} />
      </ArchiveFilterEnhancer>
      {chips.length ? <nav aria-label="Active replay filters" className="flex flex-wrap items-center gap-2 border-b border-border p-4">{chips.map(({ key, label }) => <FilterChip key={key} label={label} href={archiveHref(root, query, { ...resetPage, [key]: undefined })} />)}{chips.length >= 2 ? <LinkButton href={root} variant="ghost" size="sm">Clear all</LinkButton> : null}</nav> : null}
      <section id="replay-results" tabIndex={-1} aria-label="Replay results" className="scroll-mt-24 focus:outline-none">
        <ArchiveSummary data={data} query={query} />
        <ReplayList items={items} owner={false} playerName={profile.displayName} publicHandle={profile.handle}
          listQuery={archiveHref("", query).replace(/^\?/, "")}
          emptyTitle={hasLocalFilters ? "No replays match these filters" : "No shared replays yet"}
          emptyDescription={hasLocalFilters ? "Clear or broaden the replay filters to see more games." : `When ${profile.displayName} syncs a replay, it will appear here automatically.`} />
      </section>
      {query.cursor || page.hasMore ? <nav aria-label="Replay pages" className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line px-4 py-3">
        {query.cursor ? <LinkButton href={archiveHref(root, query, resetPage) + "#replay-results"} variant="secondary" size="sm" iconLeft={<ArrowLeft className="h-4 w-4" aria-hidden />}>Back to {query.sort === "date_asc" ? "oldest" : "newest"}</LinkButton> : <span />}
        {page.hasMore && page.nextCursor ? <LinkButton href={archiveHref(root, query, { cursor: page.nextCursor, page: nextPage }) + "#replay-results"} variant="secondary" size="sm" iconRight={<ChevronRight className="h-4 w-4" aria-hidden />}>{query.sort === "date_asc" ? "Newer" : "Older"} replays</LinkButton> : null}
      </nav> : null}
    </Card>
    <p className="text-center text-micro text-text-dim">Shared by {profile.displayName}. Anyone with this link can browse the list and download replays. Downloads are the original .SC2Replay file, which includes the in-game names and chat StarCraft II records.</p>
  </article>;
}

function ArchiveSelect({ label, name, value, options }: { label: string; name: string; value: string; options: string[][] }) {
  return <label className="min-w-0"><span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">{label}</span><Select name={name} defaultValue={value} className="min-h-11">{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</Select></label>;
}
