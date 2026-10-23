import Link from "next/link";
import { X } from "lucide-react";
import { boardQuery, LEAGUE_BANDS, tagLabel, type BoardFilters } from "@/lib/reviews";

export function hasBoardFilters(filters: BoardFilters): boolean { return !!(filters.race || filters.matchup || filters.band != null || filters.tag || filters.unanswered); }
export function ActiveFilterChips({ filters }: { filters: BoardFilters }) {
  const chips: Array<{ key: keyof BoardFilters; label: string }> = [];
  if (filters.race) chips.push({ key: "race", label: `Race: ${{ P: "Protoss", T: "Terran", Z: "Zerg" }[filters.race]}` });
  if (filters.matchup) chips.push({ key: "matchup", label: `Matchup: ${filters.matchup}` });
  if (filters.band != null) chips.push({ key: "band", label: `League: ${LEAGUE_BANDS.find((band) => band.id === filters.band)?.label ?? filters.band}` });
  if (filters.tag) chips.push({ key: "tag", label: `Focus: ${tagLabel(filters.tag)}` });
  if (filters.unanswered) chips.push({ key: "unanswered", label: "Unanswered" });
  if (!chips.length) return null;
  return <div role="group" aria-label="Active review filters" className="flex flex-wrap items-center gap-2">{chips.map(({ key, label }) => <Link key={key} href={`/reviews${boardQuery({ ...filters, [key]: key === "unanswered" ? false : null })}`} aria-label={`Remove filter ${label}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 text-caption font-medium text-accent hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}<X className="h-3.5 w-3.5" aria-hidden /></Link>)}<Link href={`/reviews${boardQuery({ sort: filters.sort, race: null, matchup: null, band: null, tag: null, unanswered: false })}`} className="inline-flex min-h-11 items-center px-2 text-caption font-semibold text-link hover:underline">Clear all</Link></div>;
}
