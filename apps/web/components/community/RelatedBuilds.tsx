import Link from "next/link";
import { getJson } from "@/lib/serverApi";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { coerceRace, raceIconName, raceTint } from "@/lib/race";
import type {
  CommunityBuildListItem,
  CommunityBuildListResponse,
} from "./types";

export interface RelatedBuildsProps {
  matchup?: string;
  /** Slug of the current build — excluded from the list. */
  currentSlug: string;
}

/**
 * RelatedBuilds — top 4 community builds in the same matchup.
 *
 * Server component: fetched at request time and revalidated alongside
 * the surrounding page (1-minute revalidate via getJson). Renders a
 * compact link list rather than full cards so the sidebar stays
 * lightweight.
 */
export async function RelatedBuilds({
  matchup,
  currentSlug,
}: RelatedBuildsProps) {
  if (!matchup) {
    return null;
  }
  const data = await getJson<CommunityBuildListResponse>(
    `/v1/community/builds?matchup=${encodeURIComponent(matchup)}&sort=top&limit=6`,
  );
  const items = (data?.items ?? [])
    .filter((b) => b.slug !== currentSlug)
    .slice(0, 4);
  if (items.length === 0) {
    return null;
  }
  return (
    <Card>
      <h2 className="text-caption font-semibold uppercase tracking-wider text-text">
        More {matchup} builds
      </h2>
      <ul className="mt-3 space-y-2">
        {items.map((b) => (
          <RelatedRow key={b.slug} build={b} />
        ))}
      </ul>
    </Card>
  );
}

function RelatedRow({ build }: { build: CommunityBuildListItem }) {
  const race = coerceRace(build.build?.race);
  const tint = raceTint(race);
  return (
    <li>
      <Link
        href={`/community/builds/${encodeURIComponent(build.slug)}`}
        className="group flex items-start gap-2 rounded-md border border-transparent p-2 transition-colors hover:border-border hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-elevated">
          <Icon
            name={raceIconName(race)}
            kind="race"
            size={20}
            decorative
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-text group-hover:text-accent-cyan">
            {build.title}
          </span>
          <span className="mt-0.5 inline-flex items-center gap-2 text-[11px] text-text-muted">
            <span className={tint.text}>{build.matchup || "—"}</span>
            <span aria-hidden className="text-text-dim">
              ·
            </span>
            <span className="font-mono tabular-nums">
              {build.votes >= 0 ? "▲" : "▼"} {Math.abs(build.votes)}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}
