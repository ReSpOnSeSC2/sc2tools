import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  PublicReplayLibrary,
  type PublicReplayQuery,
} from "@/components/public-profile/PublicReplayLibrary";
import { PublicReplayUnavailable } from "@/components/public-profile/PublicReplayUnavailable";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { getJsonWithStatus } from "@/lib/serverApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ player: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function fetchReplays(player: string, query: PublicReplayQuery = {}) {
  const params = new URLSearchParams({ limit: "25", sort: query.sort || "date_desc" });
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.cursor) params.set("cursor", query.cursor);
  return getJsonWithStatus<ReplayLibraryResponse>(
    `/v1/public/replays/${encodeURIComponent(player)}?${params.toString()}`,
  );
}

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { player } = await params;
  const { data, status } = await fetchReplays(player);
  const canonicalPlayer = data?.profile.handle || player;
  const canonical = `/players/${encodeURIComponent(canonicalPlayer)}/replays`;
  if (!data?.profile) {
    if (status === 404) notFound();
    return {
      title: "Shared replays · SC2 Tools",
      description: "This shared replay archive is temporarily unavailable.",
      robots: { index: false, follow: false },
      alternates: { canonical },
    };
  }
  const title = `${data.profile.displayName}'s StarCraft II replays · SC2 Tools`;
  const description = `Browse and download ${data.profile.displayName}'s shared StarCraft II replays without an account. Replay analysis and macro breakdowns are available after signing in.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: { type: "website", title, description, url: canonical },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PlayerReplaysPage({ params, searchParams }: PageProps) {
  const [{ player }, rawQuery] = await Promise.all([params, searchParams]);
  const query = parseQuery(rawQuery);
  const { data, status } = await fetchReplays(player, query);
  if (!data?.profile) {
    if (status === 404) notFound();
    return <PublicReplayUnavailable />;
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
