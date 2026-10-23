import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { PublicReplayLibrary } from "@/components/public-profile/PublicReplayLibrary";
import { archiveFilterLabels, archiveHref, parseArchiveQuery, type PublicReplayQuery } from "@/components/public-profile/archiveQuery";
import { PublicUnavailable } from "@/components/public-profile/PublicUnavailable";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { getJsonWithStatus } from "@/lib/serverApi";
import { siteTitle } from "@/lib/siteTitle";
import { currentSeasonPresetId, resolvePreset } from "@/lib/datePresets";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ player: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const fetchReplays = cache((player: string, queryKey: string) =>
  getJsonWithStatus<ReplayLibraryResponse>(`/v1/public/replays/${encodeURIComponent(player)}?${queryKey}`),
);
const requestTime = cache(() => new Date());

function queryKey(query: PublicReplayQuery): string {
  const params = new URLSearchParams({ limit: "25", sort: query.sort || "date_desc" });
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.map) params.set("map", query.map);
  if (query.build) params.set("build", query.build);
  if (query.range) {
    const now = requestTime();
    const range = query.range === "season" ? resolvePreset(currentSeasonPresetId()) : { since: new Date(now.getTime() - (query.range === "7d" ? 7 : 30) * 86_400_000), until: now };
    if (range.since) params.set("since", range.since.toISOString());
    if (range.until) params.set("until", range.until.toISOString());
  }
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
      const href = archiveHref(archiveRoot(canonical.data.profile.handle), query, { cursor: undefined, page: undefined });
      redirect(`${href}${href.includes("?") ? "&" : "?"}notice=page-expired`);
    }
    if (canonical.status === 404 || canonical.status === 429 || canonical.status === null || (canonical.status ?? 0) >= 500) return canonical;
  }
  return result;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ player }, rawQuery] = await Promise.all([params, searchParams]);
  const { data, status } = await readArchive(player, parseArchiveQuery(rawQuery));
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
  const query = parseArchiveQuery(rawQuery);
  const { data, status } = await readArchive(player, query);
  if (!data?.profile) {
    if (status === 404) notFound();
    const filtered = Boolean(query.cursor || archiveFilterLabels(query).length);
    return <PublicUnavailable surface="archive" reason={status === 429 ? "busy" : "outage"} resetHref={filtered ? archiveRoot(player) : undefined} />;
  }
  // Legacy opaque share ids remain resolvable during migration, but every
  // successful response carries the canonical player slug. Normalize the
  // browser URL before it is copied or shared again.
  if (data.profile.handle !== player) {
    redirect(archiveHref(archiveRoot(data.profile.handle), query));
  }
  return <PublicReplayLibrary data={data} query={query} />;
}

function archiveRoot(player: string) { return `/players/${encodeURIComponent(player)}/replays`; }
