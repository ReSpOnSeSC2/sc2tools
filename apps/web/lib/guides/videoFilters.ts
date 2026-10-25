import type { GuideMatchup, GuideVideo } from "./types";

// Keep this client module independent of the full build catalog.
export const VIDEO_MATCHUPS: readonly GuideMatchup[] = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];
export type VideoMatchupFilter = GuideMatchup | "other" | "all";

export function videoMatchup(value: unknown): GuideMatchup | null {
  return typeof value === "string" ? VIDEO_MATCHUPS.find((matchup) => matchup.toLowerCase() === value.toLowerCase()) ?? null : null;
}

export function parseVideoMatchup(value: unknown): VideoMatchupFilter {
  return value === "other" ? "other" : videoMatchup(value) ?? "all";
}

function foldTitle(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Both the request render and client interactions use exactly the same filter. */
export function filterGuideVideos(videos: readonly GuideVideo[], matchup: VideoMatchupFilter, search = ""): GuideVideo[] {
  const query = foldTitle(search.trim());
  return videos.filter((video) => {
    const detected = videoMatchup(video.matchup);
    return (matchup === "all" || (matchup === "other" ? detected === null : detected === matchup)) && foldTitle(video.title).includes(query);
  });
}

export function videoGuidePath(video: GuideVideo): { matchup: string; slug: string } | null {
  const matchup = videoMatchup(video.matchup);
  const slug = video.buildSlug;
  return matchup && typeof slug === "string" && slug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    ? { matchup: matchup.toLowerCase(), slug } : null;
}
