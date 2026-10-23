"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ListFilter, Search, X } from "lucide-react";
import { Input } from "@/components/ui/Input";

/** A native GET form first; hydration adds automatic submission and clearing. */
export function ArchiveFilterEnhancer({ action, search = "", build, children }: { action: string; search?: string; build?: string; children: ReactNode }) {
  const formRef = useRef<HTMLFormElement>(null); const searchRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(search); const [enhanced, setEnhanced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setEnhanced(true);
    const focusResults = () => { if (window.location.hash === "#replay-results") document.getElementById("replay-results")?.focus({ preventScroll: true }); };
    focusResults(); window.addEventListener("hashchange", focusResults);
    return () => { clearTimeout(timer.current); window.removeEventListener("hashchange", focusResults); };
  }, []);
  function submit() { clearTimeout(timer.current); formRef.current?.requestSubmit(); }
  function changeSearch(next: string) {
    setValue(next); clearTimeout(timer.current);
    if (!next.trim() || next.trim().length >= 2) timer.current = setTimeout(submit, 400);
  }
  return <form ref={formRef} action={action} method="get" className="border-b-2 border-line p-4" role="search" onSubmit={() => clearTimeout(timer.current)} onChange={(event) => { if (event.target instanceof HTMLSelectElement) submit(); }}>
    {build ? <input type="hidden" name="build" value={build} /> : null}
    <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <label className="relative min-w-0 sm:col-span-2 xl:col-span-2">
        <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">Search replays</span>
        <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-text-dim" aria-hidden />
        <Input ref={searchRef} type="search" name="search" value={value} onChange={(event) => changeSearch(event.target.value)} placeholder="Player, map, build or strategy" className="pl-9 pr-11" maxLength={100} />
        {enhanced && value ? <button type="button" aria-label="Clear search" onClick={() => { setValue(""); if (searchRef.current) searchRef.current.value = ""; submit(); }} className="absolute bottom-0 right-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X className="h-4 w-4" aria-hidden /></button> : null}
      </label>
      {children}
      <button type="submit" hidden={enhanced} className={`${enhanced ? "hidden" : "inline-flex"} hard-press h-11 min-w-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5 font-display text-body font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}><ListFilter className="h-4 w-4" aria-hidden /> Apply</button>
    </div>
  </form>;
}
