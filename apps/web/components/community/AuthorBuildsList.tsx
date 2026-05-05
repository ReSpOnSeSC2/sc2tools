"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { CommunityBuildCard } from "./CommunityBuildCard";
import type { CommunityBuildListItem } from "./types";

export interface AuthorBuildsListProps {
  builds: CommunityBuildListItem[];
}

/**
 * AuthorBuildsList — paginated grid of an author's published builds.
 *
 * Filters by matchup against the static set of matchups present in the
 * author's library so the UI never advertises a filter that yields
 * zero rows. Pure client-side: the full list is small enough to ship
 * in one payload (capped by the API to non-removed builds).
 */
export function AuthorBuildsList({ builds }: AuthorBuildsListProps) {
  const matchups = useMemo(() => {
    const set = new Set<string>();
    for (const b of builds) {
      if (b.matchup) set.add(b.matchup);
    }
    return Array.from(set).sort();
  }, [builds]);

  const [matchup, setMatchup] = useState<string>("");
  const filtered = useMemo(
    () => (matchup ? builds.filter((b) => b.matchup === matchup) : builds),
    [matchup, builds],
  );

  if (builds.length === 0) {
    return (
      <Section title="Published builds">
        <Card>
          <EmptyStatePanel
            title="No published builds yet"
            description="When this author publishes a build it'll appear here."
          />
        </Card>
      </Section>
    );
  }

  return (
    <Section
      title="Published builds"
      description={`${builds.length} build${builds.length === 1 ? "" : "s"} ranked by votes within their matchup`}
    >
      {matchups.length > 1 ? (
        <nav
          aria-label="Filter by matchup"
          className="-mx-1 flex flex-wrap items-center gap-1.5 px-1 pb-3"
        >
          <Button
            type="button"
            size="sm"
            variant={!matchup ? "primary" : "secondary"}
            onClick={() => setMatchup("")}
            aria-pressed={!matchup}
          >
            All
          </Button>
          {matchups.map((mu) => (
            <Button
              key={mu}
              type="button"
              size="sm"
              variant={matchup === mu ? "primary" : "secondary"}
              onClick={() => setMatchup(mu)}
              aria-pressed={matchup === mu}
            >
              {mu}
            </Button>
          ))}
        </nav>
      ) : null}
      {filtered.length === 0 ? (
        <Card>
          <EmptyStatePanel
            size="sm"
            title={`No ${matchup} builds`}
            description="Pick a different matchup to see this author's other work."
          />
        </Card>
      ) : (
        <ul
          role="list"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {filtered.map((b) => (
            <li key={b.slug} role="listitem" className="h-full">
              <CommunityBuildCard build={b} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
