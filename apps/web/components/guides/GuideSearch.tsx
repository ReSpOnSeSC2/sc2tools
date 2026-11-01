"use client";

import { useId, useRef, useState } from "react";
import { usePageSearchShortcut } from "@/lib/usePageSearchShortcut";
import { useCommandSearch } from "@/components/chrome/CommandSearchContext";

/** Explicit public guide discovery; no metadata request until the player opens search.
 * Without JavaScript or a search provider, the form submits to the /search results page. */
export function GuideSearch({ matchup }: { matchup?: string }) {
  const search = useCommandSearch(), input = useRef<HTMLInputElement>(null), id = useId();
  const [query, setQuery] = useState("");
  usePageSearchShortcut(input);
  return <form role="search" aria-label="Find a guide" action="/search" method="get" onSubmit={event => {
    if (!search) return;
    event.preventDefault(); search.open({ scope: "guides", query, defaultMatchup: matchup,
      returnFocus: input.current });
  }} className="min-w-0 space-y-2 rounded-xl border border-border bg-bg-surface p-4">
    <label htmlFor={id} className="block font-semibold text-text">Find a guide</label>
    <div className="flex min-w-0 flex-wrap gap-2">
      <input id={id} ref={input} type="search" name="q" value={query} maxLength={160} autoComplete="off"
        onChange={event => setQuery(event.target.value)} placeholder="Build, opponent opening or map…"
        className="min-h-11 min-w-0 flex-1 rounded-md border border-border-strong bg-bg px-3 text-text
          focus:outline-none focus:ring-2 focus:ring-accent" />
      <button type="submit" className="min-h-11 rounded-full border-2 border-line px-4
        font-semibold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Search</button>
    </div>
    <p className="text-caption text-text-muted">Enter a build, matchup or map, then Search. Press / to focus this field.</p>
  </form>;
}
