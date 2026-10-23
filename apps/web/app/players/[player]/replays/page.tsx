import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import {
  PublicReplayLibrary,
  type PublicReplayQuery,
} from "@/components/public-profile/PublicReplayLibrary";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { getJsonWithStatus } from "@/lib/serverApi";
import { siteTitle } from "@/lib/siteTitle";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ player: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const fetchReplays = cache((player: string, queryKey: string) =>
  getJsonWithStatus<ReplayLibraryResponse>(`/v1/public/replays/${encodeURIComponent(player)}?${queryKey}`),
);

function queryKey(query: PublicReplayQuery): string {
  const params = new URLSearchParams({ limit: "25", sort: query.sort || "date_desc" });
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}

async function readArchive(player: string, query: PublicReplayQuery) {
  const result = await fetchReplays(player, queryKey(query));
  if (result.status === 400 && query.cursor) {
    // An invalid cursor response cannot carry the canonical handle. The
    // exceptional recovery read asks only for the public profile, never VODs.
    const canonical = await fetchReplays(player, "limit=1&fields=profile");
    if (canonical.data?.profile) {
      const href = replayListHref(canonical.data.profile.handle, { ...query, cursor: undefined });
      redirect(`${href}${href.includes("?") ? "&" : "?"}notice=page-expired`);
    }
    if (canonical.status === 404 || canonical.status === 429 || canonical.status === null || (canonical.status ?? 0) >= 500) return canonical;
  }
  return result;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ player }, rawQuery] = await Promise.all([params, searchParams]);
  const { data, status } = await readArchive(player, parseQuery(rawQuery));
  const canonicalPlayer = data?.profile.handle || player;
  const canonical = `/players/${encodeURIComponent(canonicalPlayer)}/replays`;
  if (!data?.profile) {
    if (status === 404) notFound();
    return {
      title: "Shared replays",
      description: "This shared replay archive is temporarily unavailable.",
      robots: { index: false, follow: false },
      alternates: { canonical },
    };
  }
  const title = `${data.profile.displayName}'s StarCraft II replays`;
  // Social cards get no title template, so they carry the brand themselves.
  const shareTitle = siteTitle(title);
  const description = `Browse and download ${data.profile.displayName}'s shared StarCraft II replays without an account. Replay analysis and macro breakdowns are available after signing in.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: { type: "website", title: shareTitle, description, url: canonical },
    twitter: { card: "summary_large_image", title: shareTitle, description },
  };
}

export default async function PlayerReplaysPage({ params, searchParams }: PageProps) {
  const [{ player }, rawQuery] = await Promise.all([params, searchParams]);
  const query = parseQuery(rawQuery);
  const { data, status } = await readArchive(player, query);
  if (!data?.profile) {
    if (status === 404) notFound();
    const filtered = Boolean(query.cursor || query.search || query.result || query.matchup || query.sort === "date_asc");
    return <PublicUnavailable surface="archive" reason={status === 429 ? "busy" : "outage"} resetHref={filtered ? replayListHref(player, {}) : undefined} />;
  }
  // Legacy opaque share ids remain resolvable during migration, but every
  // successful response carries the canonical player slug. Normalize the
  // browser URL before it is copied or shared again.
  if (data.profile.handle !== player) {
    redirect(replayListHref(data.profile.handle, query));
  }
  return <PublicReplayLibrary data={data} query={query} />;
}

function parseQuery(raw: Record<string, string | string[] | undefined>): PublicReplayQuery {
  const read = (key: string) => {
    const value = raw[key];
    return (Array.isArray(value) ? value[0] : value)?.trim();
  };
  const result = read("result");
  const matchup = read("matchup");
  const sort = read("sort");
  return {
    search: read("search")?.slice(0, 100) || undefined,
    result: result === "win" || result === "loss" || result === "tie" ? result : undefined,
    matchup: MATCHUP_RE.test(matchup || "") ? matchup : undefined,
    sort: sort === "date_asc" ? "date_asc" : "date_desc",
    cursor: read("cursor")?.slice(0, 512) || undefined,
    notice: read("notice") === "page-expired" ? "page-expired" : undefined,
  };
}

function replayListHref(player: string, query: PublicReplayQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.sort && query.sort !== "date_desc") params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  const encoded = params.toString();
  const root = `/players/${encodeURIComponent(player)}/replays`;
  return encoded ? `${root}?${encoded}` : root;
}

const MATCHUP_RE = /^[PTZR]v[PTZR]$/;
