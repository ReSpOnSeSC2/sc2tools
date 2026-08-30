import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  ListFilter,
  LockKeyhole,
  Radio,
  Search,
  Share2,
} from "lucide-react";
import { ReplayList } from "@/components/analyzer/replays/ReplayList";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { Select } from "@/components/ui/Select";

export interface PublicReplayQuery {
  search?: string;
  result?: "win" | "loss" | "tie";
  matchup?: string;
  sort?: "date_desc" | "date_asc";
  cursor?: string;
}

export function PublicReplayLibrary({
  data,
  query,
}: {
  data: ReplayLibraryResponse;
  query: PublicReplayQuery;
}) {
  const { profile, items, page } = data;
  const root = `/players/${encodeURIComponent(profile.handle)}/replays`;
  const hasLocalFilters = Boolean(query.search || query.result || query.matchup || query.sort === "date_asc");

  return (
    <article className="space-y-6">
      <Card variant="feature" padded={false} className="relative overflow-hidden">
        <div className="absolute -right-16 -top-20 h-60 w-60 rounded-full bg-accent-cyan/12 blur-3xl" aria-hidden />
        <div className="relative p-5 sm:p-7">
          <PageHeader
            eyebrow={
              <span className="inline-flex flex-wrap items-center gap-2">
                <Share2 className="h-4 w-4" aria-hidden />
                Shared replay archive
                <Badge variant="cyan" size="sm">Live from synced games</Badge>
              </span>
            }
            title={`${profile.displayName}'s replays`}
            description="A game-by-game record with public replay downloads and timestamped stream POVs, plus signed-in replay analysis and macro breakdowns."
          />
          <div className="mt-5 flex flex-col gap-2 rounded-xl border border-border bg-bg-elevated/55 p-3 text-caption text-text-muted sm:flex-row sm:items-center sm:gap-5">
            <span className="inline-flex items-center gap-2">
              <Download className="h-4 w-4 text-accent-cyan" aria-hidden />
              View the list and download replays without an account
            </span>
            <span className="inline-flex items-center gap-2">
              <LockKeyhole className="h-4 w-4 text-warning" aria-hidden />
              Sign in for Macro and Analysis
            </span>
          </div>
        </div>
      </Card>

      <Card padded={false}>
        <form action={root} method="get" className="border-b-2 border-line p-4" role="search">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <label className="relative min-w-0 flex-1">
              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Search replays</span>
              <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-text-dim" aria-hidden />
              <Input
                name="search"
                defaultValue={query.search || ""}
                placeholder="Player, map, build or strategy"
                className="pl-9"
                maxLength={100}
              />
            </label>
            <label className="lg:w-36">
              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Result</span>
              <Select name="result" defaultValue={query.result || ""}>
                <option value="">All results</option>
                <option value="win">Wins</option>
                <option value="loss">Losses</option>
                <option value="tie">Ties</option>
              </Select>
            </label>
            <label className="lg:w-36">
              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Matchup</span>
              <Select name="matchup" defaultValue={query.matchup || ""}>
                <option value="">All matchups</option>
                {MATCHUPS.map((value) => <option key={value} value={value}>{value}</option>)}
              </Select>
            </label>
            <label className="lg:w-40">
              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Order</span>
              <Select name="sort" defaultValue={query.sort || "date_desc"}>
                <option value="date_desc">Newest first</option>
                <option value="date_asc">Oldest first</option>
              </Select>
            </label>
            <div className="flex gap-2">
              <button type="submit" className="hard-press inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5 font-display text-body font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <ListFilter className="h-4 w-4" aria-hidden /> Apply
              </button>
              {hasLocalFilters ? (
                <Link href={root} className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-full border-2 border-line bg-bg-surface px-4 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Clear</Link>
              ) : null}
            </div>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-elevated/35 px-4 py-2.5">
          <p className="text-caption text-text-muted">
            <span className="font-semibold text-text">{items.length}</span> replay{items.length === 1 ? "" : "s"} on this page
          </p>
          {items.some((item) => item.streams?.length) ? (
            <span className="inline-flex items-center gap-1.5 text-micro text-text-muted">
              <Radio className="h-3.5 w-3.5 text-danger" aria-hidden /> Timestamped Twitch / YouTube POVs included
            </span>
          ) : null}
        </div>

        <ReplayList
          items={items}
          owner={false}
          playerName={profile.displayName}
          publicHandle={profile.handle}
          emptyTitle={hasLocalFilters ? "No replays match these filters" : "No shared replays yet"}
          emptyDescription={hasLocalFilters
            ? "Clear or broaden the replay filters to see more games."
            : `When ${profile.displayName} syncs a replay, it will appear here automatically.`}
        />

        {query.cursor || page.hasMore ? (
          <nav aria-label="Replay pages" className="flex items-center justify-between gap-3 border-t-2 border-line px-4 py-3">
            {query.cursor ? (
              <Link href={queryHref(root, query, null)} className={pageLinkClass}>
                <ArrowLeft className="h-4 w-4" aria-hidden /> Back to newest
              </Link>
            ) : <span />}
            {page.hasMore && page.nextCursor ? (
              <Link href={queryHref(root, query, page.nextCursor)} className={pageLinkClass}>
                Older replays <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            ) : null}
          </nav>
        ) : null}
      </Card>

      <p className="text-center text-micro text-text-dim">
        Shared by {profile.displayName}. This list and its replay downloads are public; Macro and Analysis require an SC2 Tools sign-in. Page data omits SC2 Tools account and storage fields, while an original replay can expose metadata embedded by StarCraft II.
      </p>
    </article>
  );
}

function queryHref(root: string, query: PublicReplayQuery, cursor: string | null): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.sort && query.sort !== "date_desc") params.set("sort", query.sort);
  if (cursor) params.set("cursor", cursor);
  const encoded = params.toString();
  return encoded ? `${root}?${encoded}` : root;
}

const pageLinkClass = "inline-flex min-h-[44px] items-center gap-2 rounded-full border-2 border-line bg-bg-surface px-4 font-display text-caption font-bold text-text transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ", "RvP", "RvT", "RvZ"] as const;
