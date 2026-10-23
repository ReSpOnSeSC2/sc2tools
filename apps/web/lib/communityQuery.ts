import { SKILL_LEVELS, type SkillLevelId } from "@/lib/build-rules";
import { COMMUNITY_SORTS, type CommunitySort } from "@/components/community/types";

export type CommunityRace = "" | "P" | "T" | "Z";
export type CommunityQuery = {
  race: CommunityRace; vs: CommunityRace; skill: SkillLevelId | "";
  sort: CommunitySort; search: string; offset: number;
  mine?: boolean;
};
export const COMMUNITY_PAGE_SIZE = 24;
export const COMMUNITY_RACE_NAMES = { P: "Protoss", T: "Terran", Z: "Zerg" } as const;
export const communityRace = (value: unknown): CommunityRace => value === "P" || value === "T" || value === "Z" ? value : "";

export function parseCommunityQuery(sp: Record<string, string | string[] | undefined>): CommunityQuery {
  if (sp.mine === "1") return { race: "", vs: "", skill: "", sort: "top", search: "", offset: 0, mine: true };
  const legacy = typeof sp.matchup === "string" && /^[PTZ]v[PTZ]$/.test(sp.matchup) ? sp.matchup : "";
  const skill = typeof sp.skill === "string" && SKILL_LEVELS.some((item) => item.id === sp.skill) ? sp.skill as SkillLevelId : "";
  const offset = typeof sp.offset === "string" ? Number.parseInt(sp.offset, 10) : 0;
  return {
    race: communityRace(sp.race) || communityRace(legacy[0]), vs: communityRace(sp.vs) || communityRace(legacy[2]), skill,
    sort: COMMUNITY_SORTS.some((item) => item.value === sp.sort) ? sp.sort as CommunitySort : "top",
    search: typeof sp.q === "string" ? sp.q.trim().slice(0, 80) : "",
    offset: Number.isFinite(offset) ? Math.min(1_000_000_000, Math.max(0, offset)) : 0,
  };
}

export function communityHref(query: CommunityQuery): string {
  if (query.mine) return "/community?mine=1";
  const sp = new URLSearchParams();
  if (query.race) sp.set("race", query.race);
  if (query.vs) sp.set("vs", query.vs);
  if (query.skill) sp.set("skill", query.skill);
  if (query.sort !== "top") sp.set("sort", query.sort);
  if (query.search) sp.set("q", query.search);
  if (query.offset > 0) sp.set("offset", String(query.offset));
  return `/community${sp.size ? `?${sp}` : ""}`;
}

export function clearCommunityFilters(query: CommunityQuery): CommunityQuery {
  return { ...query, race: "", vs: "", skill: "", search: "", offset: 0 };
}

export function communityEmptyTitle(query: CommunityQuery): string {
  const race = query.race ? `${COMMUNITY_RACE_NAMES[query.race]} ` : "";
  const vs = query.vs ? ` vs ${COMMUNITY_RACE_NAMES[query.vs]}` : "";
  const skill = query.skill ? ` at ${SKILL_LEVELS.find((item) => item.id === query.skill)?.label}` : "";
  return query.search ? `No ${race}builds${vs}${skill} match “${query.search}”` : `No ${race}builds${vs}${skill} yet`;
}
