import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicReplayLibrary, type PublicReplayQuery } from "@/components/public-profile/PublicReplayLibrary";
import { PublicReplayUnavailable } from "@/components/public-profile/PublicReplayUnavailable";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { getJsonWithStatus } from "@/lib/serverApi";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function fetchReplays(handle: string, query: PublicReplayQuery = {}) {
  const params = new URLSearchParams({ limit: "25", sort: query.sort || "date_desc" });
  if (query.search) params.set("search", query.search);
  if (query.result) params.set("result", query.result);
  if (query.matchup) params.set("matchup", query.matchup);
  if (query.cursor) params.set("cursor", query.cursor);
  return getJsonWithStatus<ReplayLibraryResponse>(
    `/v1/public/replays/${encodeURIComponent(handle)}?${params.toString()}`,
  );
}

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { handle } = await params;
  const { data, status } = await fetchReplays(handle);
  const canonical = `/p/${encodeURIComponent(handle)}/replays`;
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
  const description = `Browse ${data.profile.displayName}'s shared StarCraft II replay history, including replay downloads, game analysis, macro breakdowns and available stream POVs.`;
  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical },
    openGraph: { type: "website", title, description, url: canonical },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicReplaysPage({ params, searchParams }: PageProps) {
  const [{ handle }, rawQuery] = await Promise.all([params, searchParams]);
  const query = parseQuery(rawQuery);
  const { data, status } = await fetchReplays(handle, query);
  if (!data?.profile) {
    if (status === 404) notFound();
    return <PublicReplayUnavailable />;
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

const MATCHUP_RE = /^[PTZR]v[PTZR]$/;
