"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { GLOSSARY, glossaryHelpPath } from "@/lib/glossary";

const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
type NavigationRequest = { view: object; container: HTMLDivElement; origin: HTMLAnchorElement;
  focused: Element | null; url: string; frame: number | null; cleanup: () => void };

/** Public IDs are stable glossary links. Compact Help can mount several
 * articles, so it keeps the existing data-help-anchor contract instead.
 */
export function GlossaryBrowser({ variant = "page" }: { variant?: "page" | "compact" }) {
  const [query, setQuery] = useState("");
  const inputId = useId(), statusId = useId();
  const root = useRef<HTMLDivElement>(null);
  const view = useMemo(() => ({ variant }), [variant]);
  const currentView = useRef(view); currentView.current = view;
  const navigation = useRef<NavigationRequest | null>(null);
  const retireNavigation = useCallback(() => {
    const request = navigation.current; navigation.current = null;
    if (!request) return;
    if (request.frame !== null) cancelAnimationFrame(request.frame);
    request.cleanup();
  }, []);
  useEffect(() => () => retireNavigation(), [view, retireNavigation]);
  const terms = useMemo(() => [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term, "en")), []);
  const filtered = terms.filter(term => normalize([term.term, term.short, term.long ?? ""].join(" ")).includes(normalize(query.trim())));
  const letters = [...new Set(filtered.map(term => term.term.charAt(0).toUpperCase()))];
  function showTerm(event: MouseEvent<HTMLAnchorElement>, id: string) {
    retireNavigation();
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (variant === "page" && !query) return;
    event.preventDefault(); setQuery("");
    const container = root.current;
    if (!container) return;
    const request: NavigationRequest = { view, container, origin: event.currentTarget,
      focused: document.activeElement, url: location.href, frame: null, cleanup: () => {} };
    const invalidate = () => { if (navigation.current === request) retireNavigation(); };
    const focusChanged = (focus: FocusEvent) => {
      if (focus.target !== request.origin && focus.target !== request.focused) invalidate();
    };
    // Listen only while this single frame is queued. A newer reader action
    // owns focus/URL even if the old target still matches the new search.
    document.addEventListener("pointerdown", invalidate, true);
    document.addEventListener("keydown", invalidate, true);
    document.addEventListener("focusin", focusChanged, true);
    window.addEventListener("popstate", invalidate);
    window.addEventListener("hashchange", invalidate);
    request.cleanup = () => {
      document.removeEventListener("pointerdown", invalidate, true);
      document.removeEventListener("keydown", invalidate, true);
      document.removeEventListener("focusin", focusChanged, true);
      window.removeEventListener("popstate", invalidate);
      window.removeEventListener("hashchange", invalidate);
    };
    navigation.current = request;
    // This work follows an explicit local link, never an automatic tour or
    // analyzer navigation. The target exists after the filter clears.
    request.frame = requestAnimationFrame(() => {
      if (navigation.current !== request) return;
      const active = document.activeElement;
      const ownsFocus = active === request.origin || active === request.focused
        || active === document.body && !request.origin.isConnected;
      if (currentView.current !== request.view || !container.isConnected || root.current !== container
        || location.href !== request.url || !ownsFocus) { retireNavigation(); return; }
      retireNavigation();
      const target = container.querySelector<HTMLElement>(`[data-glossary-id="${id}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "nearest" }); target.focus();
      if (variant === "page") history.replaceState(history.state, "", `#${id}`);
    });
  }
  return <div ref={root} className="space-y-4">
    <div className="space-y-1">
      <label htmlFor={inputId} className="block text-caption font-semibold text-text">Search glossary</label>
      <input id={inputId} value={query} onChange={event => { retireNavigation(); setQuery(event.target.value); }} aria-describedby={statusId}
        onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); retireNavigation(); setQuery(""); } }}
        className="min-h-11 w-full rounded-md border border-border bg-bg px-3 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <p id={statusId} role="status" aria-live="polite" className="text-caption text-text-muted">{filtered.length} term{filtered.length === 1 ? "" : "s"}</p>
    </div>
    <nav aria-label="Glossary A to Z" className="flex flex-wrap gap-1">
      {Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map(letter => letters.includes(letter) ? <a key={letter}
        href={`#glossary-letter-${letter.toLowerCase()}`} onClick={event => {
          retireNavigation();
          if (variant !== "compact" || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); root.current?.querySelector<HTMLElement>(`[data-glossary-letter="${letter}"]`)?.scrollIntoView({ block: "nearest" });
        }} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded font-semibold text-accent-cyan underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{letter}</a>
        : <span key={letter} aria-disabled="true" className="inline-flex min-h-11 min-w-11 items-center justify-center text-text-dim">{letter}</span>)}
    </nav>
    {filtered.length === 0 ? <p className="text-body text-text-muted">No terms match. Try another word or clear the search.</p> : letters.map(letter => <section key={letter} className="space-y-3" aria-label={`Terms beginning with ${letter}`}>
      <h3 id={variant === "page" ? `glossary-letter-${letter.toLowerCase()}` : undefined} data-glossary-letter={letter} className="scroll-mt-24 font-display text-h3 text-text">{letter}</h3>
      <dl className="space-y-4">{filtered.filter(term => term.term.charAt(0).toUpperCase() === letter).map(term => <div key={term.id}
        id={variant === "page" ? term.id : undefined} data-help-anchor={variant === "compact" ? term.id : undefined}
        data-glossary-id={term.id} tabIndex={-1} className="scroll-mt-24 rounded-lg border border-border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <dt className="text-body font-semibold text-text">{term.term}</dt>
        <dd className="mt-1 space-y-2 text-caption text-text-muted"><p>{term.short}</p>{term.long ? <p>{term.long}</p> : null}
          <Link href={glossaryHelpPath(term)} className="inline-flex min-h-11 items-center rounded font-semibold text-accent-cyan underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Read {term.term} in context</Link>
          {term.related.length ? <p>Related: {term.related.map((id, index) => <span key={id}>{index ? ", " : ""}<a href={`#${id}`} onClick={event => showTerm(event, id)} className="rounded text-accent-cyan underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{terms.find(related => related.id === id)?.term ?? id}</a></span>)}</p> : null}
        </dd>
      </div>)}</dl>
    </section>)}
  </div>;
}
