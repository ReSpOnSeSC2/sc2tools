"use client";

import { useEffect, useRef } from "react";
import type { AnalyzerFilters } from "@/lib/filterContext";
import { isAnalyzerViewPath, replaceViewQuery, viewFiltersFromQuery, viewFiltersQuery } from "@/lib/analyzerViews";
import { useUrlQueryWriter } from "@/lib/useUrlQueryWriter";

/** Query changes come from the router (including Back/Forward). Our own
 * debounced replaces are recognized so they never become storage writes. */
export function AnalyzerFilterUrlSync({ ready, filters, onNavigate }: {
  ready: boolean; filters: AnalyzerFilters; onNavigate: (parsed: ReturnType<typeof viewFiltersFromQuery>) => void;
}) {
  const { path: pathname, search, owned, capture, update } = useUrlQueryWriter();
  const invalidView = viewFiltersFromQuery(new URLSearchParams(search)).error;
  const observedHref = useRef("");

  useEffect(() => {
    if (!ready || !isAnalyzerViewPath(pathname)) return;
    const href = `${pathname}?${search}`;
    if (observedHref.current === href) return;
    observedHref.current = href;
    if (owned) return;
    const query = new URLSearchParams(search), parsed = viewFiltersFromQuery(query);
    if (parsed.error) { onNavigate(parsed); return; }
    if (!parsed.present) return;
    onNavigate(parsed);
  }, [ready, pathname, search, owned, onNavigate]);

  useEffect(() => {
    if (!ready || !isAnalyzerViewPath(pathname) || invalidView) return;
    const guard = capture();
    const timer = window.setTimeout(() => {
      if (window.location.pathname !== pathname) return;
      // A navigation can change the address before Next publishes new
      // searchParams. Never replace that incoming cohort with this timer's
      // older filter state. The next router render schedules its own write.
      if (new URLSearchParams(window.location.search).toString() !== search) return;
      update(params => {
        const next = new URLSearchParams(replaceViewQuery(params.toString(), filters));
        if (pathname.startsWith("/app/sessions") && viewFiltersQuery(viewFiltersFromQuery(params).filters).toString() !== viewFiltersQuery(filters).toString()) {
          next.delete("before"); next.delete("gamesBefore");
        }
        return next;
      }, "replace", guard);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ready, pathname, search, filters, capture, update, invalidView]);

  const useCurrentFilters = () => {
    onNavigate(viewFiltersFromQuery(new URLSearchParams(replaceViewQuery(search, filters))));
    update(params => new URLSearchParams(replaceViewQuery(params.toString(), filters)));
  };
  return ready && invalidView ? <div role="alert" className="m-4 space-y-3 rounded-lg border border-danger p-4 text-body"><p>{invalidView} Open a new link, or continue with your current filters.</p><button type="button" className="min-h-11 rounded-lg border border-border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={useCurrentFilters}>Use current filters</button></div> : null;
}
