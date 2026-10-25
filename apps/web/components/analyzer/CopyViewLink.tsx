"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useFilters } from "@/lib/filterContext";
import { analyzerViewHref, isAnalyzerViewPath } from "@/lib/analyzerViews";

export function CopyViewLink() {
  const pathname = usePathname(), { filters } = useFilters();
  const [copied, setCopied] = useState(false), [fallback, setFallback] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const attempt = useRef({ id: 0 }), scope = useRef({ filters, pathname });
  scope.current = { filters, pathname };
  useEffect(() => { const generation = attempt.current; generation.id++; setCopied(false); setFallback(""); return () => { generation.id++; }; }, [filters, pathname]);
  useEffect(() => { if (fallback) { field.current?.focus(); field.current?.select(); } }, [fallback]);
  if (!pathname || !isAnalyzerViewPath(pathname)) return null;
  const copy = async () => {
    const id = ++attempt.current.id;
    const url = `${window.location.origin}${analyzerViewHref({ section: pathname.split("/")[2] || "today", filters })}`;
    const current = () => attempt.current.id === id && scope.current.filters === filters && scope.current.pathname === pathname;
    try { await navigator.clipboard.writeText(url); if (current()) { setCopied(true); setFallback(""); } }
    catch { if (current()) setFallback(url); }
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-2"><button type="button" onClick={() => { void copy(); }} className="min-h-11 rounded-md px-2 text-caption font-medium text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Copy link to this view</button>{copied ? <span role="status" className="text-micro text-success">View link copied.</span> : null}{fallback ? <label className="min-w-0 flex-1 text-micro text-text-muted">Copy this view link<input ref={field} readOnly value={fallback} onFocus={event => event.currentTarget.select()} className="ml-2 min-h-11 w-full min-w-0 rounded border border-border bg-bg-surface px-2 text-caption" /></label> : null}</div>;
}
