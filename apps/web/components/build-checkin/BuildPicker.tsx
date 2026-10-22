"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { Check, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  groupBuildOptions,
  recordText,
  winRateText,
  type BuildOption,
} from "@/lib/buildIntent";

export interface BuildPickerProps {
  /** Undefined while the list is still loading. */
  options: readonly BuildOption[] | undefined;
  loading?: boolean;
  /** Friendly load error; shows a Retry action when `onRetry` is given. */
  error?: string | null;
  onRetry?: () => void;
  /** Selected option key. */
  value: string | null;
  onChange: (option: BuildOption) => void;
  rolledKey?: string | null;
  usualKey?: string | null;
  suggestedKey?: string | null;
  /** Accessible name of the list, e.g. "Build you went for". */
  label?: string;
  /** Group headings; the opponent list uses "Faced before" / "All builds". */
  groupTitles?: { yours: string; all: string };
  /** Search box placeholder. */
  searchPlaceholder?: string;
  /**
   * Offer to create a build that isn't listed yet. Called with the
   * current search text (trimmed; "" when empty), which the editor
   * uses as the new build's name.
   */
  onAddNew?: (query: string) => void;
  /** Text of the "add" action when no search text names the build. */
  addNewLabel?: string;
  /**
   * Move focus into the search box once it can take it (the list may
   * still be loading when the picker opens). Only the first time.
   */
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

const DEFAULT_GROUP_TITLES = { yours: "Your builds", all: "All builds" } as const;

/**
 * BuildPicker — searchable single-select list of the builds a player can
 * check in to, grouped as "Your builds" (custom, played or in the
 * randomizer pool) and "All builds" (the rest of the catalog). Rows keep
 * the server's order, so nothing moves under the pointer. With `onAddNew`
 * an "Add new build…" action sits under the list; when the search matches
 * nothing it offers the search text as the new build's name.
 *
 * Keyboard: the search box is an ARIA combobox that owns the listbox; the
 * arrow keys move the highlighted row (aria-activedescendant), Enter picks
 * it, Escape clears the search.
 */
export function BuildPicker({
  options,
  loading = false,
  error = null,
  onRetry,
  value,
  onChange,
  rolledKey = null,
  usualKey = null,
  suggestedKey = null,
  label = "Build you went for",
  groupTitles = DEFAULT_GROUP_TITLES,
  searchPlaceholder = "Search builds…",
  onAddNew,
  addNewLabel = "Add new build…",
  autoFocus = false,
  disabled = false,
  className = "",
}: BuildPickerProps) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const didAutoFocus = useRef(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => groupBuildOptions(options ?? [], query),
    [options, query],
  );
  const flat = useMemo(() => [...groups.yours, ...groups.all], [groups]);
  const [activeKey, setActiveKey] = useState<string | null>(value);

  // Keep the highlight on a visible row: the selection when it is shown,
  // otherwise the first match.
  const activeIndex = useMemo(() => {
    const index = flat.findIndex((option) => option.key === activeKey);
    if (index >= 0) return index;
    const selected = flat.findIndex((option) => option.key === value);
    return selected >= 0 ? selected : flat.length > 0 ? 0 : -1;
  }, [flat, activeKey, value]);
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const activeId = activeIndex >= 0 ? optionId(activeIndex) : undefined;

  useEffect(() => {
    if (!activeId) return;
    const node = document.getElementById(activeId);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const start = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.min(flat.length - 1, Math.max(0, start + delta));
    setActiveKey(flat[next].key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "PageDown":
        event.preventDefault();
        move(5);
        break;
      case "PageUp":
        event.preventDefault();
        move(-5);
        break;
      case "Enter":
        if (activeIndex >= 0) {
          event.preventDefault();
          onChange(flat[activeIndex]);
        }
        break;
      case "Escape":
        if (query) {
          event.preventDefault();
          event.stopPropagation();
          setQuery("");
        }
        break;
      default:
        break;
    }
  };

  const total = options?.length ?? 0;
  const matchCount = flat.length;
  const waiting = loading && options === undefined;
  const inputDisabled = disabled || waiting || Boolean(error && !options);
  const trimmedQuery = query.trim();

  // `autoFocus` on the element only works on mount, and a disabled input
  // can't take focus: the list is often still loading when the picker
  // opens. Focus once it is usable, and only once, so a busy toggle
  // during a write never pulls focus back here.
  useEffect(() => {
    if (!autoFocus || inputDisabled || didAutoFocus.current) return;
    didAutoFocus.current = true;
    inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, inputDisabled]);

  return (
    <div className={["space-y-2", className].filter(Boolean).join(" ")}>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
          aria-hidden
        />
        <input
          type="text"
          role="combobox"
          aria-label={`Search: ${label}`}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          spellCheck={false}
          ref={inputRef}
          disabled={inputDisabled}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveKey(null);
          }}
          onKeyDown={onKeyDown}
          className="block h-10 w-full rounded-lg border-2 border-line bg-bg-surface pl-9 pr-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label={label}
        aria-busy={waiting || undefined}
        className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border-2 border-line bg-bg"
      >
        {waiting ? (
          <PickerSkeleton />
        ) : error && !options ? (
          <div role="alert" className="space-y-2 px-3 py-4 text-caption text-text-muted">
            <p>{error}</p>
            {onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : total === 0 ? (
          <div className="px-3 py-4 text-caption text-text-muted">
            <p>No builds for this matchup yet.</p>
            {onAddNew ? null : (
              <Link
                href="/builds"
                className="mt-1 inline-flex min-h-11 items-center font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Create one in your build library
              </Link>
            )}
          </div>
        ) : matchCount === 0 ? (
          <p className="px-3 py-4 text-caption text-text-muted">
            No builds match “{trimmedQuery}”.
          </p>
        ) : (
          <>
            <OptionGroup
              title={groupTitles.yours}
              baseId={`${baseId}-yours`}
              options={groups.yours}
              offset={0}
              optionId={optionId}
              activeIndex={activeIndex}
              value={value}
              rolledKey={rolledKey}
              usualKey={usualKey}
              suggestedKey={suggestedKey}
              disabled={disabled}
              onHover={setActiveKey}
              onPick={onChange}
            />
            <OptionGroup
              title={groupTitles.all}
              baseId={`${baseId}-all`}
              options={groups.all}
              offset={groups.yours.length}
              optionId={optionId}
              activeIndex={activeIndex}
              value={value}
              rolledKey={rolledKey}
              usualKey={usualKey}
              suggestedKey={suggestedKey}
              disabled={disabled}
              onHover={setActiveKey}
              onPick={onChange}
            />
          </>
        )}
      </div>
      {onAddNew && !waiting && !(error && !options) ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAddNew(trimmedQuery)}
          className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md px-1 text-left text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {trimmedQuery && matchCount === 0
              ? `Add “${trimmedQuery}” as a new build…`
              : addNewLabel}
          </span>
        </button>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {waiting
          ? "Loading builds"
          : options
            ? `${matchCount} build${matchCount === 1 ? "" : "s"} listed`
            : ""}
      </p>
    </div>
  );
}

function OptionGroup({
  title,
  baseId,
  options,
  offset,
  optionId,
  activeIndex,
  value,
  rolledKey,
  usualKey,
  suggestedKey,
  disabled,
  onHover,
  onPick,
}: {
  title: string;
  baseId: string;
  options: BuildOption[];
  offset: number;
  optionId: (index: number) => string;
  activeIndex: number;
  value: string | null;
  rolledKey: string | null;
  usualKey: string | null;
  suggestedKey: string | null;
  disabled: boolean;
  onHover: (key: string) => void;
  onPick: (option: BuildOption) => void;
}) {
  if (options.length === 0) return null;
  const headingId = `${baseId}-heading`;
  return (
    <div role="group" aria-labelledby={headingId}>
      <div
        id={headingId}
        role="presentation"
        className="sticky top-0 z-10 border-b border-border bg-bg-elevated px-3 py-1.5 text-micro font-bold uppercase tracking-[0.12em] text-text-dim"
      >
        {title}
      </div>
      {options.map((option, index) => {
        const flatIndex = offset + index;
        const selected = option.key === value;
        const active = flatIndex === activeIndex;
        return (
          <div
            key={option.key}
            id={optionId(flatIndex)}
            role="option"
            aria-selected={selected}
            aria-disabled={disabled || undefined}
            data-build-key={option.key}
            // Keep focus in the search box so the keyboard model holds.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (!active) onHover(option.key);
            }}
            onClick={() => {
              if (!disabled) onPick(option);
            }}
            className={[
              "flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1.5 text-caption",
              "motion-safe:transition-colors motion-safe:duration-100",
              active ? "bg-accent/10" : "",
              selected ? "font-semibold text-text" : "text-text",
              disabled ? "cursor-not-allowed opacity-60" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center text-accent" aria-hidden>
              {selected ? <Check className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate" title={option.name}>
                {option.name}
              </span>
              <OptionMarks
                option={option}
                rolled={option.key === rolledKey}
                usual={option.key === usualKey}
                suggested={option.key === suggestedKey}
              />
            </span>
            <RecordChip wins={option.wins} losses={option.losses} />
          </div>
        );
      })}
    </div>
  );
}

function OptionMarks({
  option,
  rolled,
  usual,
  suggested,
}: {
  option: BuildOption;
  rolled: boolean;
  usual: boolean;
  suggested: boolean;
}) {
  if (!rolled && !usual && !suggested && option.source !== "custom") return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1">
      {suggested ? (
        <Badge size="sm" variant="accent">
          Suggested
        </Badge>
      ) : null}
      {rolled ? (
        <Badge size="sm" variant="signal">
          Rolled
        </Badge>
      ) : null}
      {usual ? (
        <Badge size="sm" variant="cyan">
          Usual
        </Badge>
      ) : null}
      {option.source === "custom" ? (
        <span className="text-micro text-text-dim">Custom</span>
      ) : null}
    </span>
  );
}

/** "7–5 · 58%" with the record coloured; "New" when never played. */
export function RecordChip({ wins, losses }: { wins: number; losses: number }) {
  const rate = winRateText(wins, losses);
  if (rate == null) {
    return (
      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-micro text-text-dim">
        New
        <span className="sr-only">: no decided games yet</span>
      </span>
    );
  }
  const [w, l] = recordText(wins, losses).split("–");
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-surface px-2 py-0.5 text-micro tabular-nums">
      <span aria-hidden>
        <span className="font-bold text-success">{w}</span>
        <span className="text-text-dim">–</span>
        <span className="font-bold text-danger">{l}</span>
      </span>
      <span aria-hidden className="text-text-muted">
        {rate}
      </span>
      <span className="sr-only">
        {`${w} wins, ${l} losses, ${rate} win rate`}
      </span>
    </span>
  );
}

function PickerSkeleton() {
  return (
    <div className="space-y-2 p-3" aria-hidden>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className="h-8 rounded-md bg-bg-elevated motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}
