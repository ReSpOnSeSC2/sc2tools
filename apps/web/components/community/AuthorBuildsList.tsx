"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { CommunityBuildCard } from "./CommunityBuildCard";
import type { CommunityBuildListItem } from "./types";

/** Browsing needs public metadata, not author identity or ownership hints. */
export type AuthorBuildListRow = Pick<CommunityBuildListItem,
  "slug" | "title" | "description" | "matchup" | "votes" | "publishedAt" | "updatedAt" | "build">;
export interface AuthorBuildsListProps { builds: AuthorBuildListRow[] }

export function AuthorBuildsList({ builds }: AuthorBuildsListProps) {
  const [matchup, setMatchup] = useState("");
  const [sort, setSort] = useState<"top" | "new">("new");
  const [search, setSearch] = useState("");
  const matchups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const build of builds) if (build.matchup) counts.set(build.matchup, (counts.get(build.matchup) ?? 0) + 1);
    return Array.from(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [builds]);
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("en-US");
    const items = builds.filter((build) => (!matchup || build.matchup === matchup) && (!term || `${build.title} ${build.description}`.toLocaleLowerCase("en-US").includes(term)));
    // New retains the API's published-date order; Top has a deterministic date tie-break.
    return sort === "new" ? items : items.sort((a, b) => b.votes - a.votes || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }, [builds, matchup, search, sort]);
  if (!builds.length) return <Section title="Published builds"><Card><EmptyStatePanel title="No published builds yet" description="When this author publishes a build it'll appear here." /></Card></Section>;
  return <Section title="Published builds" description={`${builds.length} build${builds.length === 1 ? "" : "s"} · ${sort === "top" ? "Highest scores first" : "Most recently published first"}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <SegmentedControl label="Sort author's builds" value={sort} options={[{ value: "top", label: "Top" }, { value: "new", label: "New" }]} onChange={setSort} />
      {builds.length >= 6 ? <Input type="search" aria-label="Search author's builds" placeholder="Search title or description" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-0 sm:max-w-xs" /> : null}
    </div>
    {matchups.length ? <nav aria-label="Filter by matchup" className="mb-3 flex flex-wrap gap-1.5">
      <Button size="sm" variant={!matchup ? "primary" : "secondary"} onClick={() => setMatchup("")} aria-pressed={!matchup}>All · {builds.length}</Button>
      {matchups.map(([name, count]) => <Button key={name} size="sm" variant={matchup === name ? "primary" : "secondary"} onClick={() => setMatchup(name)} aria-pressed={matchup === name}>{name} · {count}</Button>)}
    </nav> : null}
    {!filtered.length ? <Card><EmptyStatePanel size="sm" title={search.trim() ? `No builds match “${search.trim()}”` : `No ${matchup} builds`} description="Try a different keyword or matchup." action={<Button variant="secondary" onClick={() => { setSearch(""); setMatchup(""); }}>Clear</Button>} /></Card> : <ul aria-label="Published builds" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">{filtered.map((build) => <li key={build.slug} className="h-full"><CommunityBuildCard build={build} hideAuthor /></li>)}</ul>}
  </Section>;
}
