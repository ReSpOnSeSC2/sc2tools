import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { GUIDE_LINK_CLASS, GUIDE_PANEL_CLASS } from "@/components/guides/guideUi";
import { createCommandGuideCatalog } from "@/lib/commandGuideSearch";
import { COMMAND_GUIDE_GROUPS, searchCommands, type CommandSearchGroup } from "@/lib/commandSearch";
import { fetchGuideIndex, fetchPublishedGuidePaths } from "@/lib/guides/api";
import { guidesEnabled } from "@/lib/guides/flags";
import { PUBLIC_SEARCH_PATH, PUBLIC_SEARCH_QUERY_MAX, parsePublicSearchQuery, publicSearchHref } from "@/lib/publicSearchQuery";
import { pageMetadata } from "@/lib/seo/pageMetadata";

/**
 * /search?q= — published guides for one search, on one page (ADR 0069,
 * 2026-11-01 amendment). The palette's own guide catalog and scorer run here
 * over the same cached anonymous guide reads guide pages make; the query
 * never reaches the API. Rendered per request, noindex, never in the sitemap,
 * with a fixed title and a strict-origin referrer so an old query stays out of
 * the next page's referrer.
 */
export const dynamic = "force-dynamic";

const TITLE = "Search guides";
export const metadata: Metadata = {
  ...pageMetadata({
    title: TITLE,
    description: "Search published StarCraft II opener, counter and map guides.",
    canonical: PUBLIC_SEARCH_PATH,
  }),
  title: TITLE,
  robots: { index: false, follow: true },
  referrer: "strict-origin",
};

/** At most 30 rows per group; a 31st means there are more. */
const SHOWN = 30;
const LIMITS = { perGroup: SHOWN + 1, total: (SHOWN + 1) * COMMAND_GUIDE_GROUPS.length };

type Results = { kind: "unavailable" } | { kind: "ready"; groups: CommandSearchGroup[]; mapsChecked: boolean };

async function searchGuides(query: string): Promise<Results> {
  const [published, index] = await Promise.all([fetchPublishedGuidePaths(), fetchGuideIndex()]);
  // Unknown publication is never shown as an empty or a fully published set.
  if (published === null) return { kind: "unavailable" };
  const maps = index.kind === "ok" ? index.data.maps.map(({ map, slug }) => ({ map, slug })) : [];
  // Only positively published guides are listed, so unpublished rows never use up the caps.
  const rows = createCommandGuideCatalog({ publishedPaths: published, maps }).filter(row => row.href && !row.disabled);
  return { kind: "ready", groups: searchCommands(rows, query, COMMAND_GUIDE_GROUPS, LIMITS), mapsChecked: index.kind === "ok" };
}

function SearchForm({ value }: { value: string }) {
  return <form role="search" aria-label="Search guides" action={PUBLIC_SEARCH_PATH} method="get"
    className="flex min-w-0 flex-wrap items-end gap-2">
    <label className="min-w-0 flex-1 space-y-1">
      <span className="block font-semibold text-text">Search guides</span>
      <input name="q" type="search" defaultValue={value} maxLength={PUBLIC_SEARCH_QUERY_MAX * 2} autoComplete="off"
        spellCheck={false} placeholder="Build, opponent opening or map…"
        className="min-h-11 w-full min-w-0 rounded-md border border-border-strong bg-bg px-3 text-text
          focus:outline-none focus:ring-2 focus:ring-accent" />
    </label>
    <button type="submit" className={buttonClassName({ variant: "secondary" })}>Search</button>
  </form>;
}

function ResultGroup({ group }: { group: CommandSearchGroup }) {
  const id = `search-${group.id}`, rows = group.items.slice(0, SHOWN);
  return <section aria-labelledby={id} className={`${GUIDE_PANEL_CLASS} min-w-0 space-y-2 p-4`}>
    <h2 id={id} className="text-h3 font-semibold text-text">{group.label}</h2>
    <ul className="min-w-0 space-y-1">
      {rows.map(row => <li key={row.id} className="min-w-0">
        <Link href={row.href!} className="flex min-h-11 min-w-0 flex-col justify-center gap-0.5 rounded-md px-2 py-1
          hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 break-words font-medium text-text">{row.label}</span>
            {row.matchup ? <span className="rounded border border-border bg-bg-elevated px-1.5 text-caption text-text-muted">
              {row.matchup}</span> : null}
          </span>
          {row.description ? <span className="break-words text-caption text-text-muted">{row.description}</span> : null}
        </Link>
      </li>)}
    </ul>
    {group.items.length > SHOWN ? <p className="text-caption text-text-muted">
      More matches in {group.label}. Add a matchup or another word.</p> : null}
  </section>;
}

function Browse() {
  return <p className="text-body text-text-muted">
    Browse <Link href="/guides" className={GUIDE_LINK_CLASS}>all build guides</Link> or{" "}
    <Link href="/guides/maps" className={GUIDE_LINK_CLASS}>map guides</Link>.
  </p>;
}

function Answer({ query, results }: { query: string; results: Results }) {
  if (results.kind === "unavailable") {
    return <div role="status" className="space-y-2">
      <p className="text-body text-text">Guide search is temporarily unavailable.</p>
      <p className="text-body text-text-muted"><a href={publicSearchHref(query) ?? PUBLIC_SEARCH_PATH} className={GUIDE_LINK_CLASS}>
        Try again</a>, or browse <Link href="/guides" className={GUIDE_LINK_CLASS}>all build guides</Link>.</p>
    </div>;
  }
  const count = results.groups.reduce((sum, group) => sum + Math.min(group.items.length, SHOWN), 0);
  return <div className="space-y-4">
    <p role="status" className="text-body text-text-muted">
      {count ? `${count} published ${count === 1 ? "guide matches" : "guides match"}.`
        : "No published guides match. Guides appear here once enough games are recorded."}
    </p>
    {!results.mapsChecked ? <p className="text-caption text-text-muted">Map guides couldn&apos;t be checked right now.</p> : null}
    {results.groups.map(group => <ResultGroup key={group.id} group={group} />)}
    {!count ? <Browse /> : null}
  </div>;
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!guidesEnabled()) notFound();
  const parsed = parsePublicSearchQuery((await searchParams).q);
  // Empty, too long and invalid searches render with no guide read.
  const results = parsed.kind === "ok" ? await searchGuides(parsed.query) : null;
  return <div className="mx-auto w-full max-w-3xl min-w-0 space-y-6">
    <PageHeader eyebrow="Guides" title="Search guides" description="Published opener, counter and map guides." />
    <SearchForm value={parsed.kind === "ok" ? parsed.query : parsed.kind === "too_long" ? parsed.prefill : ""} />
    <p className="text-caption text-text-muted">Try “12 pool”, “PvZ stargate” or a map name.</p>
    {parsed.kind === "ok" && results ? <Answer query={parsed.query} results={results} />
      : parsed.kind === "too_long" ? <p role="status" className="text-body text-text">Searches can be up to 80 characters.</p>
        : parsed.kind === "invalid" ? <p role="status" className="text-body text-text">
          This search can&apos;t be used. Use letters, numbers and spaces.</p>
          : <Browse />}
  </div>;
}
