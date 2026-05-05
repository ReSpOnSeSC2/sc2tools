/**
 * Public-API shapes for the /community pages.
 *
 * Mirrors the projection in apps/api/src/services/community.js — kept
 * narrow on purpose so a stray field accidentally leaked by a future
 * server change doesn't compile here.
 */
import type { CustomBuild } from "@/components/builds/types";

/**
 * Build summary returned by GET /v1/community/builds. The `build`
 * snapshot field is omitted in list responses but included on detail
 * responses.
 */
export interface CommunityBuildListItem {
  slug: string;
  ownerUserId: string;
  title: string;
  description: string;
  matchup?: string;
  authorName?: string;
  votes: number;
  publishedAt: string;
  updatedAt?: string;
  build?: Partial<CustomBuild>;
}

export interface CommunityBuildListResponse {
  items: CommunityBuildListItem[];
  hasMore: boolean;
  total: number;
  offset: number;
  limit: number;
}

export interface CommunityBuildDetail extends CommunityBuildListItem {
  build: Partial<CustomBuild>;
}

export type CommunitySort = "top" | "new" | "controversial";

export const COMMUNITY_SORTS: ReadonlyArray<{
  value: CommunitySort;
  label: string;
  hint: string;
}> = [
  { value: "top", label: "Top", hint: "Highest-voted first" },
  { value: "new", label: "New", hint: "Most recently published" },
  {
    value: "controversial",
    label: "Controversial",
    hint: "High engagement, divided votes",
  },
];

/**
 * Author-profile aggregate from GET /v1/community/authors/:userId.
 */
export interface CommunityAuthorProfile {
  userId: string;
  displayName: string;
  joinedAt: string | null;
  builds: CommunityBuildListItem[];
  totalBuilds: number;
  totalVotes: number;
  primaryRace: string | null;
  topMatchup: string | null;
  topBuild: CommunityBuildListItem | null;
  recent: CommunityBuildListItem[];
}

/**
 * Test for whether a build has a public author (i.e. `authorName` is
 * present) — drives both link rendering on the list/detail pages and
 * the 404 branch on the author profile.
 */
export function hasPublicAuthor(
  b: Pick<CommunityBuildListItem, "authorName" | "ownerUserId">,
): b is CommunityBuildListItem & { authorName: string; ownerUserId: string } {
  return (
    typeof b.authorName === "string" &&
    b.authorName.trim().length > 0 &&
    typeof b.ownerUserId === "string" &&
    b.ownerUserId.length > 0
  );
}
