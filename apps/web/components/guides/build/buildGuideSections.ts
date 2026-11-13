import type { GuideBuildPublished, GuideCommunityBuildLink, GuideExampleReplay } from "@/lib/guides/types";
import { sharedAnalysisHref } from "@/components/public-profile/archiveQuery";
import { isPublicReplayReference } from "@/lib/replayRouteAccess";
import { safeVideoUrls } from "../youtubeUrls";
import type { SectionNavItem } from "@/components/ui/SectionNav";

const COMMUNITY_SLUG_RE = /^[A-Za-z0-9-]{1,120}$/;
const SHARE_HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{10}$/;

export function hasCommunityBuildLink(build: GuideCommunityBuildLink): boolean {
  return typeof build?.slug === "string" && COMMUNITY_SLUG_RE.test(build.slug);
}

export function hasExampleReplayLink(example: GuideExampleReplay): boolean {
  return typeof example?.handle === "string" && example.handle.length <= 64 && SHARE_HANDLE_RE.test(example.handle)
    && isPublicReplayReference(example.replayRef)
    && example.href === sharedAnalysisHref(`/players/${example.handle}/replays`, example.replayRef);
}

/** The rendering plan is also the navigation plan, so absent data cannot leave dead links. */
export function buildGuideSections(payload: GuideBuildPublished): SectionNavItem[] {
  const items: SectionNavItem[] = [];
  if (payload.videos.length) items.push({ id: "video", label: "Video" });
  if (payload.bands.league.length || payload.bands.mmr.length) items.push({ id: "win-rate-by-band", label: "By league" });
  items.push(payload.timings?.milestones.length ? { id: "key-timings", label: "Timings" } : { id: "your-record", label: "Your record" });
  if (Object.values(payload.army ?? {}).some((checkpoint) => checkpoint?.units.length)) items.push({ id: "army", label: "Army" });
  if (payload.vsStrategy.length) items.push({ id: "vs-openers", label: "Matchups" });
  if (payload.lengths.length) items.push({ id: "when-it-wins", label: "Game length" });
  if (payload.maps.length) items.push({ id: "maps", label: "Maps" });
  if (payload.leaks?.items.length || payload.macro) items.push({ id: "macro-leaks", label: "Leaks" });
  if (payload.related.length || payload.communityBuilds.some(hasCommunityBuildLink) || payload.examples.some(hasExampleReplayLink)) {
    items.push({ id: "related", label: "Related" });
  }
  if (payload.notes?.body.trim()) items.push({ id: "coach-notes", label: "Coach's notes" });
  if (payload.eightWorkerVideos?.some((video) => safeVideoUrls(video).watch)) items.push({ id: "eight-worker-videos", label: "8-worker videos" });
  return items;
}
