"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { GUIDE_PANEL_CLASS, GUIDE_SECONDARY_ACTION_CLASS } from "@/components/guides/guideUi";
import { compareSelection, MAX_COMPARE_OPENERS, openerCompareHref } from "@/lib/guides/compareSelection";
import type { GuideOpenerRow } from "@/lib/guides/types";

export function useOpenerComparison(matchupSlug: string, enabled: boolean) {
  const key = "sc2tools.guides.compare.v1." + matchupSlug;
  const [state, setState] = useState<{ key: string; slugs: string[] }>({ key, slugs: [] });
  const slugs = enabled && state.key === key ? state.slugs : [];
  useEffect(() => {
    if (!enabled) return;
    let stored: string[] = [];
    try {
      stored = compareSelection(JSON.parse(sessionStorage.getItem(key) ?? "[]")).slugs;
    } catch { /* Comparison works in memory when storage is blocked. */ }
    setState({ key, slugs: stored });
  }, [enabled, key]);
  const store = (next: string[]) => {
    setState({ key, slugs: next });
    try { sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Comparison works in memory. */ }
  };
  return {
    slugs,
    clear: () => store([]),
    toggle: (slug: string) => {
      if (slugs.includes(slug)) store(slugs.filter((selected) => selected !== slug));
      else if (slugs.length < MAX_COMPARE_OPENERS) store([...slugs, slug]);
    },
  };
}

export type OpenerComparison = ReturnType<typeof useOpenerComparison>;

export function CompareOpenerCheckbox({ row, comparison }: { row: GuideOpenerRow; comparison: OpenerComparison }) {
  const hint = useId();
  if (!row.published) return null;
  const selected = comparison.slugs.includes(row.buildSlug);
  const limited = !selected && comparison.slugs.length >= MAX_COMPARE_OPENERS;
  return <label className="inline-flex min-h-11 items-center gap-2 text-caption text-text-muted">
    <input type="checkbox" checked={selected} disabled={limited} onChange={() => comparison.toggle(row.buildSlug)}
      aria-label={"Compare " + row.name} aria-describedby={limited ? hint : undefined} />
    <span id={hint}>{limited ? "Compare up to 3" : "Compare"}</span>
  </label>;
}

export function OpenerComparisonBar({ matchupSlug, comparison }: { matchupSlug: string; comparison: OpenerComparison }) {
  const count = comparison.slugs.length;
  if (count < 2) return null;
  return <div className={GUIDE_PANEL_CLASS + " sticky bottom-[env(safe-area-inset-bottom)] z-20 flex flex-wrap items-center justify-between gap-2 p-2"}>
    <Link href={openerCompareHref(matchupSlug, comparison.slugs)} className={GUIDE_SECONDARY_ACTION_CLASS}>
      {"Compare " + count + " openers →"}
    </Link>
    <Button variant="ghost" size="sm" className="min-h-11" onClick={comparison.clear}>Clear</Button>
  </div>;
}
