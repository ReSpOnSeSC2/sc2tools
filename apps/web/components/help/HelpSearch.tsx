"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { helpArticlePath } from "@/lib/help/paths";
import { helpCategory } from "@/lib/help/categories";
import { helpInlinePlainText } from "@/lib/help/inline";
import type { searchHelp } from "@/lib/help/search";
import { isPlainClick } from "./HelpInline";

/**
 * Instant help search: results update on every keystroke from the
 * in-browser index (lib/help/search.ts).
 *
 * Keyboard: ↓ from the field moves into the results, ↑/↓ move between
 * them (↑ on the first returns to the field), Esc clears the field or
 * returns to it. The result count is announced politely.
 *
 * On the public hub results link to /help/<slug>; Settings → Help passes
 * `onOpenArticle` to open the matching section in place.
 */
export interface HelpSearchProps {
  /** Where a result links (default: the public article page). */
  articleHref?: (slug: string) => string;
  /** Open a result in place instead of navigating. */
  onOpenArticle?: (slug: string) => void;
  /** Visible label above the field; screen-reader-only when omitted. */
  label?: string;
  className?: string;
}

const RESULT_CLASS =
  "block px-4 py-3 hover:bg-bg-elevated focus-visible:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

function statusText(query: string, count: number): string {
  if (!query) return "";
  if (count === 0) return `No articles match “${query}”. Try other words, or browse the topics below.`;
  return count === 1 ? "1 article" : `${count} articles`;
}

export function HelpSearch({ articleHref = helpArticlePath, onOpenArticle, label, className = "" }: HelpSearchProps) {
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const [answer, setAnswer] = useState<{ query: string; results: ReturnType<typeof searchHelp>; failed?: boolean }>({ query: "", results: [] });
  const [attempt, setAttempt] = useState(0);
  const results = answer.query === trimmed ? answer.results : [];
  const searching = Boolean(trimmed && answer.query !== trimmed);
  useEffect(() => {
    if (!trimmed) return;
    let cancelled = false;
    // The article bodies are only needed once someone searches. Browsing
    // the server-rendered topics should not download the whole help library.
    void import("@/lib/help/search").then(({ searchHelp }) => {
      if (!cancelled) setAnswer({ query: trimmed, results: searchHelp(trimmed) });
    }).catch(() => {
      if (!cancelled) setAnswer({ query: trimmed, results: [], failed: true });
    });
    return () => { cancelled = true; };
  }, [trimmed, attempt]);

  const resultLinks = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? []);

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && results.length > 0) {
      event.preventDefault();
      resultLinks()[0]?.focus();
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      setQuery("");
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const links = resultLinks();
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      links[Math.min(index + 1, links.length - 1)].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else links[index - 1].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  const resultLink = (slug: string, children: ReactNode) => {
    const href = articleHref(slug);
    if (onOpenArticle) {
      return (
        <a
          href={href}
          className={RESULT_CLASS}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onOpenArticle(slug);
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={RESULT_CLASS}>
        {children}
      </Link>
    );
  };

  return (
    <div role="search" className={className}>
      <label htmlFor={inputId} className={label ? "mb-1.5 block text-caption font-semibold text-text" : "sr-only"}>
        {label ?? "Search help"}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
          aria-hidden
        />
        <Input
          ref={inputRef}
          id={inputId}
          type="search"
          inputSize="lg"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search, e.g. pairing code"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={statusId}
          aria-controls={results.length > 0 ? listId : undefined}
          className="pl-10 pr-12 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      <p id={statusId} role="status" aria-live="polite" className={trimmed ? "mt-2 text-caption text-text-dim" : "sr-only"}>
        {searching ? "Searching…" : answer.failed && answer.query === trimmed ? "Search couldn't load. Browse the topics below or try again." : statusText(trimmed, results.length)}
      </p>
      {trimmed && answer.failed && answer.query === trimmed ? (
        <button type="button" className="text-accent underline" onClick={() => setAttempt((n) => n + 1)}>Try search again</button>
      ) : null}
      {results.length > 0 ? (
        <ul
          id={listId}
          ref={listRef}
          aria-label="Search results"
          onKeyDown={onListKeyDown}
          className="mt-2 divide-y divide-border overflow-hidden rounded-lg border-2 border-line bg-bg-surface"
        >
          {results.map(({ article }) => (
            <li key={article.slug}>
              {resultLink(
                article.slug,
                <>
                  <span className="block text-body font-semibold text-text">{article.title}</span>
                  <span className="mt-0.5 block text-caption text-text-muted">
                    <span className="font-medium text-text-dim">{helpCategory(article.category).name}</span>
                    {" · "}
                    {helpInlinePlainText(article.summary)}
                  </span>
                </>,
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
