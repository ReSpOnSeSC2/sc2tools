"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { SKILL_LEVELS, type SkillLevelId } from "@/lib/build-rules";
import { communityHref, parseCommunityQuery, type CommunityRace } from "@/lib/communityQuery";
import { coerceRace, raceIconName } from "@/lib/race";
import { COMMUNITY_SORTS, type CommunitySort } from "./types";
import { useCommunityFilterState } from "./CommunityFilterContext";

export interface CommunityFilterBarProps {
  initialRace: CommunityRace; initialVs: CommunityRace; initialSkill: SkillLevelId | "";
  initialSort: CommunitySort; initialSearch: string;
}
const RACES = [{ value: "" as const, name: "Any", code: "Any" }, { value: "P" as const, name: "Protoss", code: "P" }, { value: "T" as const, name: "Terran", code: "T" }, { value: "Z" as const, name: "Zerg", code: "Z" }];
const raceOptions = RACES.map(({ value, name, code }) => ({ value, ariaLabel: name === "Any" ? "Any race" : name, label: <span className="inline-flex items-center gap-1">{value ? <Icon name={raceIconName(coerceRace(name))} kind="race" size={12} decorative /> : null}{code}</span> }));

/** Filters navigate without remounting the input, preserving focus while typing. */
export function CommunityFilterBar({ initialRace, initialVs, initialSkill, initialSort, initialSearch }: CommunityFilterBarProps) {
  const router = useRouter(); const sp = useSearchParams(); const queryString = sp.toString();
  const [search, setSearch] = useState(initialSearch);
  const [ready, setReady] = useState(false);
  const lastPushedRef = useRef(initialSearch);
  const [isPending, startTransition] = useTransition();
  const { setPending } = useCommunityFilterState();
  const id = useId();
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (initialSearch !== lastPushedRef.current) setSearch(initialSearch);
    // Acknowledge external navigation too, so Back followed by Forward restores both.
    lastPushedRef.current = initialSearch;
  }, [initialSearch]);
  useEffect(() => { setPending(isPending); }, [isPending, setPending]);
  useEffect(() => () => setPending(false), [setPending]);

  useEffect(() => {
    if (search.trim() === initialSearch) return;
    const timer = setTimeout(() => {
      const next = parseCommunityQuery(Object.fromEntries(new URLSearchParams(queryString)));
      lastPushedRef.current = search.trim();
      startTransition(() => router.replace(communityHref({ ...next, search: search.trim(), offset: 0 }), { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search, initialSearch, queryString, router]);

  function navigate(patch: Partial<{ race: CommunityRace; vs: CommunityRace; skill: SkillLevelId | ""; sort: CommunitySort }>) {
    const next = parseCommunityQuery(Object.fromEntries(new URLSearchParams(queryString)));
    lastPushedRef.current = search.trim();
    startTransition(() => router.replace(communityHref({ ...next, ...patch, search: search.trim(), offset: 0 }), { scroll: false }));
  }
  return <fieldset disabled={!ready} aria-label="Filter community builds" className="m-0 min-w-0 space-y-3 border-0 p-0">
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={80} placeholder="Search by title, description, or author" aria-label="Search community builds" className="pl-9 pr-11" />
        {isPending ? <span role="status" aria-label="Updating community builds" className="absolute right-0 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center text-text-muted"><Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /></span> : search ? <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-0 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" aria-hidden /></button> : null}
      </div>
      <label className="flex items-center gap-2 text-caption text-text-muted md:w-auto"><span>Sort</span><Select aria-label="Sort" aria-describedby={`${id}-sort-hint`} value={initialSort} onChange={(event) => navigate({ sort: event.target.value as CommunitySort })} className="min-w-[160px]">{COMMUNITY_SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}</Select></label>
    </div>
    <p id={`${id}-sort-hint`} className="text-caption text-text-muted">{COMMUNITY_SORTS.find((sort) => sort.value === initialSort)?.hint}{" "}<LazyHelpLink slug="community-builds" anchor="sorting">How sorting works</LazyHelpLink></p>
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
      <div className="flex flex-wrap items-center gap-2"><span id={`${id}-race`} className="w-14 text-caption font-semibold text-text">My race</span><SegmentedControl labelledBy={`${id}-race`} value={initialRace} options={raceOptions} onChange={(race) => navigate({ race })} /></div>
      <div className="flex flex-wrap items-center gap-2"><span id={`${id}-vs`} className="w-14 text-caption font-semibold text-text">vs</span><SegmentedControl labelledBy={`${id}-vs`} value={initialVs} options={raceOptions} onChange={(vs) => navigate({ vs })} /></div>
      <label className="flex items-center gap-2 text-caption font-semibold text-text"><span className="shrink-0">Skill level</span><Select value={initialSkill} onChange={(event) => navigate({ skill: event.target.value as SkillLevelId | "" })}><option value="">Any level</option>{SKILL_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)}</Select></label>
    </div>
  </fieldset>;
}
