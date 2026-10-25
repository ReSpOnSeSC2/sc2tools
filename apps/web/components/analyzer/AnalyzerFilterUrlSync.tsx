"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { AnalyzerFilters } from "@/lib/filterContext";
import { isAnalyzerViewPath, replaceViewQuery, viewFiltersFromQuery } from "@/lib/analyzerViews";

/** Query changes come from the router (including Back/Forward). Our own
 * debounced replaces are recognized so they never become storage writes. */
export function AnalyzerFilterUrlSync({ ready, filters, onNavigate }: {
  ready: boolean; filters: AnalyzerFilters; onNavigate: (parsed: ReturnType<typeof viewFiltersFromQuery>) => void;
}) {
  const pathname = usePathname() ?? "", params = useSearchParams(), router = useRouter();
  const search = params?.toString() ?? "";
  const invalidView = viewFiltersFromQuery(new URLSearchParams(search)).error;
  const ownHref = useRef(""), observedHref = useRef("");

  useEffect(() => {
    if (!ready || !isAnalyzerViewPath(pathname)) return;
    const href = `${pathname}?${search}`;
    if (observedHref.current === href) return;
    observedHref.current = href;
    if (ownHref.current === href) { ownHref.current = ""; return; }
    const query = new URLSearchParams(search), parsed = viewFiltersFromQuery(query);
    if (parsed.error) { onNavigate(parsed); return; }
    if (!parsed.present) return;
    onNavigate(parsed);
  }, [ready, pathname, search, onNavigate]);

  useEffect(() => {
    if (!ready || !isAnalyzerViewPath(pathname) || invalidView) return;
    const timer = window.setTimeout(() => {
      if (window.location.pathname !== pathname) return;
      // A navigation can change the address before Next publishes new
      // searchParams. Never replace that incoming cohort with this timer's
      // older filter state. The next router render schedules its own write.
      if (new URLSearchParams(window.location.search).toString() !== search) return;
      const query = replaceViewQuery(window.location.search, filters);
      const present = window.location.search.replace(/^\?/, "");
      if (query === present) return;
      ownHref.current = `${pathname}?${query}`;
      router.replace(`${pathname}${query ? `?${query}` : ""}${window.location.hash}`, { scroll: false });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ready, pathname, search, filters, router, invalidView]);

  return ready && invalidView ? <div role="alert" className="m-4 space-y-3 rounded-lg border border-danger p-4 text-body"><p>{invalidView} Open a new link, or continue with your current filters.</p><button type="button" className="min-h-11 rounded-lg border border-border px-3 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => router.replace(`${pathname}?${replaceViewQuery(search, filters)}`, { scroll: false })}>Use current filters</button></div> : null;
}
