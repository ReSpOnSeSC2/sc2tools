import Link from "next/link";
import { X } from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { SKILL_LEVELS } from "@/lib/build-rules";
import { clearCommunityFilters, communityHref, COMMUNITY_RACE_NAMES, type CommunityQuery } from "@/lib/communityQuery";

export function CommunityActiveFilters({ query }: { query: CommunityQuery }) {
  const chips: Array<{ key: "race" | "vs" | "skill" | "search"; label: string }> = [];
  if (query.race) chips.push({ key: "race", label: COMMUNITY_RACE_NAMES[query.race] });
  if (query.vs) chips.push({ key: "vs", label: `vs ${COMMUNITY_RACE_NAMES[query.vs]}` });
  if (query.skill) chips.push({ key: "skill", label: SKILL_LEVELS.find((level) => level.id === query.skill)!.label });
  if (query.search) chips.push({ key: "search", label: `“${query.search}”` });
  if (!chips.length) return null;
  return <div role="group" aria-label="Active community filters" className="flex flex-wrap items-center gap-2">{chips.map(({ key, label }) => <Link key={key} href={communityHref({ ...query, [key]: "", offset: 0 })} aria-label={`Remove filter ${label}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 text-caption font-semibold text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}<X className="h-3.5 w-3.5" aria-hidden /></Link>)}<LinkButton href={communityHref(clearCommunityFilters(query))} variant="ghost" size="sm" className="min-h-11">Clear all</LinkButton></div>;
}
