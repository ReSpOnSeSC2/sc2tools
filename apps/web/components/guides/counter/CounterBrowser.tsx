"use client";

import { useId } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { CounterLinks } from "../matchup/CounterLinks";
import { normalizeGuideSearch, useGuideTableControls } from "../useGuideTableControls";
import type { GuideCounterLink } from "@/lib/guides/types";

const SORTS = {
  toughest: { label: "Toughest first", pick: (row: GuideCounterLink) => row.ci?.high },
  games: { label: "Most played", pick: (row: GuideCounterLink) => row.games },
  name: { label: "A–Z", pick: (row: GuideCounterLink) => normalizeGuideSearch(row.name) },
};

/** Stable ranked server output; local controls never alter the canonical URL. */
export function CounterBrowser({ counters, matchupSlug }: { counters: ReadonlyArray<GuideCounterLink>; matchupSlug: string }) {
  const id = useId();
  const hasRates = counters.some((row) => row.ci && row.winRate != null);
  const controls = useGuideTableControls(counters, { sorts: SORTS, defaultSort: hasRates ? { by: "toughest", direction: "asc" } : null, filterFn: (row, query) => normalizeGuideSearch(row.name).includes(query) });
  return <div className="space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-caption font-semibold text-text">Find an opener<Input type="search" maxLength={100} aria-controls={id} value={controls.query} onChange={(event) => controls.setQuery(event.target.value)} /></label>
      <label className="text-caption font-semibold text-text">Sort by<Select value={controls.sortProps.sortBy} onChange={(event) => controls.setSortExplicit(event.target.value, event.target.value === "games" ? "desc" : "asc")}>
        {!hasRates ? <option value="">Published first</option> : null}
        {Object.entries(SORTS).map(([key, sort]) => <option key={key} value={key}>{sort.label}</option>)}
      </Select></label><p aria-live="polite" className="text-caption text-text-muted">{controls.count} of {counters.length} openers</p>
    </div>
    <div id={id}>{controls.count ? <CounterLinks counters={controls.visibleRows} matchupSlug={matchupSlug} includeUnpublished /> : <p className="text-caption text-text-muted">No opener matches “{controls.query}” <Button size="sm" variant="secondary" onClick={() => controls.setQuery("")}>Clear</Button></p>}</div>
  </div>;
}
