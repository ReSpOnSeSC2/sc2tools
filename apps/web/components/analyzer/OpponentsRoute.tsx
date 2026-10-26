"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/Card";
import { SectionHeader } from "./SectionHeader";
import { Button } from "@/components/ui/Button";
import type { OpponentExportAction } from "./opponents/types";
import { useOpponentUrlControls } from "./useOpponentUrlControls";
import { useFilters } from "@/lib/filterContext";
import { replaceViewQuery } from "@/lib/analyzerViews";

// Keep the page header available while its interactive, authenticated table
// loads. Subsequent refreshes stay inside the mounted table and retain rows.
const OpponentsTab = dynamic(() => import("./OpponentsTab").then((module) => module.OpponentsTab), {
  ssr: false,
  loading: () => <div role="status" aria-label="Loading opponent list"><Skeleton rows={8} /></div>,
});

/**
 * Route wrapper: the section header, then the opponent list, with rows
 * navigating to real dossier URLs.
 */
export function OpponentsRoute() {
  const router = useRouter();
  const pathname = usePathname() || "/app/opponents";
  const params = useSearchParams();
  const query = params?.toString() || "";
  const controls = useOpponentUrlControls(), { filters } = useFilters();
  const location = useMemo(() => ({ pathname, query, queryForReturn: () => replaceViewQuery(query, filters), replace: (href: string) => router.replace(href, { scroll: false }), prefetch: (href: string) => router.prefetch(href), navigate: (href: string) => router.push(href) }), [pathname, query, filters, router]);
  const [count, setCount] = useState<number | null>(null);
  const [exportAction, setExportAction] = useState<OpponentExportAction | null>(null);
  return (
    <div className="space-y-5">
      <SectionHeader tab="opponents" description="Everyone you've faced, keyed to their SC2Pulse ID" actions={<>{count === null ? null : <span className="rounded-full border border-line px-2 py-1 text-caption tabular-nums">{count.toLocaleString()} results</span>}{exportAction ? <Button variant="secondary" disabled={exportAction.disabled} onClick={exportAction.download} title={`Export all ${exportAction.count.toLocaleString()} matching opponents, including rows outside the render window`}>Export CSV</Button> : null}</>} />
      <OpponentsTab
        location={location}
        controls={controls}
        onResultCount={setCount}
        onExportAction={setExportAction}
      />
    </div>
  );
}
