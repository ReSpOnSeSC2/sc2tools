"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BookOpen, Check, Link2, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { useToastOptional } from "@/components/ui/Toast";
import { useCopy } from "@/lib/useCopy";
import { FilterPill } from "@/components/ui/FilterPill";
import {
  BUILD_DEFINITIONS,
  DEFINITIONS_TOTAL,
  filterDefinitions,
  type BuildDefinition,
  type StrategyMatchup,
} from "@/lib/build-definitions";
import type {
  DefinitionGuideLink,
  DefinitionGuideLinks,
} from "@/lib/guides/definitionLinks";
import { publicBuildVariantIntent } from "@/lib/buildVariantIntent";
import { BuildVariantContinuation } from "./BuildVariantContinuation";
import { raceIconName, raceTint, type Race } from "@/lib/race";
import { PracticeButton } from "@/components/practice/PracticeButton";

const RACE_FILTERS: ReadonlyArray<{ value: Race | "All"; label: string }> = [
  { value: "All", label: "All" },
  { value: "Protoss", label: "Protoss" },
  { value: "Terran", label: "Terran" },
  { value: "Zerg", label: "Zerg" },
];

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"] as const;
const RACE_BY_LETTER = { P: "Protoss", T: "Terran", Z: "Zerg" } as const;
const RACES = ["Protoss", "Terran", "Zerg"] as const;
function readFilters(params: URLSearchParams): { query: string; race: Race | "All"; matchup: StrategyMatchup | "All" } {
  const rawMatchup = params.get("matchup");
  const matchup = MATCHUPS.find((item) => item === rawMatchup) ?? "All";
  const race = matchup !== "All" ? RACE_BY_LETTER[matchup[0] as keyof typeof RACE_BY_LETTER] : RACE_BY_LETTER[params.get("race") as keyof typeof RACE_BY_LETTER] ?? "All";
  return { query: (params.get("q") ?? "").slice(0, 200), race, matchup };
}

/**
 * DefinitionsCatalog — interactive list of every build / strategy
 * detection rule in `BUILD_DEFINITIONS` (count surfaced via
 * `DEFINITIONS_TOTAL`). The race + matchup pills compose with a free-
 * text search across name, description and 8-worker patch names. Each
 * card is addressable (`/definitions#<id>`) with a copy-link button, and
 * links its published community guides (`guideLinks`, from the server).
 */
export function DefinitionsCatalog({
  guideLinks = {},
}: {
  guideLinks?: DefinitionGuideLinks;
} = {}) {
  const searchParams = useSearchParams();
  const encodedParams = searchParams.toString();
  const variantId = publicBuildVariantIntent(new URLSearchParams(encodedParams));
  const variant = BUILD_DEFINITIONS.find(definition => definition.id === variantId);
  const initial = readFilters(new URLSearchParams(encodedParams));
  const [query, setQuery] = useState(initial.query);
  const [race, setRace] = useState<Race | "All">(initial.race);
  const [matchup, setMatchup] = useState<StrategyMatchup | "All">(initial.matchup);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const previousParams = useRef(encodedParams);
  const incomingNavigation = previousParams.current !== encodedParams;
  useEffect(() => {
    // Ignore a superseded router snapshot while the current address bar
    // already reflects a newer filter or hash reveal.
    if (encodedParams !== new URLSearchParams(window.location.search).toString()) return;
    previousParams.current = encodedParams;
    const next = readFilters(new URLSearchParams(encodedParams));
    setQuery(next.query); setRace(next.race); setMatchup(next.matchup);
  }, [encodedParams]);
  useEffect(() => {
    if (incomingNavigation) return;
    const params = new URLSearchParams();
    if (variantId) params.set("variant", variantId);
    if (query) params.set("q", query);
    if (race !== "All") params.set("race", race[0]);
    if (matchup && matchup !== "All") params.set("matchup", matchup);
    const search = params.toString();
    // Filtering is entirely local. Avoid an RSC navigation whose delayed
    // response could restore old filters over a newer hash reveal.
    if (search !== window.location.search.slice(1)) {
      window.history.replaceState(null, "", `/definitions${search ? `?${search}` : ""}${window.location.hash}`);
    }
  }, [query, race, matchup, incomingNavigation, variantId]);

  const filtered = useMemo(
    () => filterDefinitions(BUILD_DEFINITIONS, query, race, matchup),
    [query, race, matchup],
  );
  const liveFilters = useRef({ query, race, matchup });
  liveFilters.current = { query, race, matchup };
  useEffect(() => {
    const reveal = () => {
      let id: string;
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
      const target = BUILD_DEFINITIONS.find((def) => def.id === id);
      if (!target) return;
      const current = liveFilters.current;
      if (!filterDefinitions([target], current.query, current.race, current.matchup).length) {
        setQuery(""); setRace("All"); setMatchup("All");
      }
      setTargetId(id);
    };
    reveal(); window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, []);
  useEffect(() => {
    if (!targetId || !filtered.some((def) => def.id === targetId)) return;
    const target = document.getElementById(targetId);
    target?.scrollIntoView?.({ block: "start", behavior: "auto" });
    target?.querySelector<HTMLElement>("[data-definition-heading]")?.focus({ preventScroll: true });
    setHighlight(targetId); setTargetId(null);
  }, [targetId, filtered]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);

  function clear() {
    setQuery("");
    setRace("All");
    setMatchup("All");
  }

  return (
    <div className="space-y-5">
      {variant ? <BuildVariantContinuation id={variant.id} name={variant.name} /> : null}
      <Card>
        <div className="space-y-3">
          <Field label="Search builds and strategies" htmlFor="def-search">
            {/* Its own id, so Field doesn't give this wrapper the input's
                id (the label must point at the input). */}
            <div className="relative" id="def-search-wrap">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dim"
              />
              <Input
                id="def-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Glaive, Proxy Robo, 12 Pool…"
                className="pl-9"
                autoComplete="off"
                maxLength={200}
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-text-muted hover:bg-bg-elevated hover:text-text"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </div>
          </Field>
          <div role="group" aria-label="Filter by race" className="flex flex-wrap gap-1.5">
            {RACE_FILTERS.map(({ value, label }) => {
              const active = race === value;
              return (
                <FilterPill
                  key={value}
                  active={active}
                  onClick={() => {
                    setRace(value);
                    setMatchup("All");
                  }}
                >
                  {value !== "All" ? (
                    <Icon
                      name={raceIconName(value as Race)}
                      kind="race"
                      size={14}
                      decorative
                    />
                  ) : null}
                  {label}
                </FilterPill>
              );
            })}
          </div>
            <div role="group" aria-label="Filter by matchup" className="flex flex-wrap gap-1.5">
              {(["All", ...MATCHUPS] as const).map((value) => {
                const active = matchup === value;
                return (
                  <FilterPill
                    key={String(value)}
                    active={active}
                    onClick={() => { setMatchup(value); if (value !== "All") setRace(RACE_BY_LETTER[value[0] as keyof typeof RACE_BY_LETTER]); }}
                    className="font-mono"
                  >
                    {value}
                  </FilterPill>
                );
              })}
            </div>
          <div className="flex items-center justify-between gap-2 text-caption text-text-dim">
            <span aria-live="polite">
              <span className="text-text">{filtered.length}</span> of{" "}
              {DEFINITIONS_TOTAL} entries
            </span>
            {query || race !== "All" || matchup !== "All" ? (
              <button
                type="button"
                onClick={clear}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-full border-2 border-line bg-bg-surface px-3 text-caption text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            title="No definitions match"
            sub="Try a different search, race, or matchup pill."
          />
        </Card>
      ) : (
        <div className="space-y-6">{RACES.map((groupRace) => {
          const entries = filtered.filter((def) => def.race === groupRace);
          if (!entries.length) return null;
          return <section key={groupRace} aria-label={`${groupRace} definitions`} className="space-y-4"><h2 className="text-h3 font-semibold text-text">{groupRace} ({entries.length})</h2>
            {([null, ...MATCHUPS.filter((item) => item[0] === groupRace[0])] as const).map((groupMatchup) => {
              const members = entries.filter((def) => def.matchup === groupMatchup);
              if (!members.length) return null;
              return <div key={groupMatchup ?? "general"} className="space-y-2"><h3 className="text-body font-semibold text-text-muted">{groupMatchup ?? `${groupRace} · general`} ({members.length})</h3><ul className="space-y-2">{members.map((def) => <li key={def.id}><DefinitionCard def={def} highlighted={highlight === def.id} guides={guideLinks[def.id] ?? []} /></li>)}</ul></div>;
            })}
          </section>;
        })}</div>
      )}
    </div>
  );
}

function DefinitionCard({
  def,
  guides,
  highlighted,
}: {
  def: BuildDefinition;
  guides: ReadonlyArray<DefinitionGuideLink>;
  highlighted: boolean;
}) {
  const tint = raceTint(def.race);
  return (
    <Card
      id={def.id}
      variant="default"
      padded={false}
      className={`scroll-mt-24 target:border-accent-cyan ${highlighted ? "ring-2 ring-accent" : ""}`}
    >
      <article className="relative flex flex-col gap-2 px-5 py-4 pl-6 sm:flex-row sm:items-start sm:gap-4">
        <span
          aria-hidden
          className={["absolute left-0 top-0 h-full w-1", tint.rail].join(" ")}
        />
        <div className="flex flex-shrink-0 items-center gap-2">
          <Badge
            variant="neutral"
            size="sm"
            className={[tint.bg, tint.border, tint.text].join(" ")}
            iconLeft={
              <Icon
                name={raceIconName(def.race)}
                kind="race"
                size={14}
                decorative
              />
            }
          >
            {def.race}
          </Badge>
          {def.matchup ? (
            <Badge variant="accent" size="sm" className="font-mono">
              {def.matchup}
            </Badge>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
            <h4 tabIndex={-1} data-definition-heading className="min-w-0 break-words pt-1.5 text-body font-semibold text-text focus:outline-none">
              {def.name}
            </h4>
            <CopyDefinitionLink id={def.id} name={def.name} />
          </div>
          <p className="text-caption text-text-muted">{def.description}</p>
          <Link href={`/builds?create=detected&definition=${encodeURIComponent(def.id)}`} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent underline underline-offset-2">Make my own variant<span className="sr-only"> of {def.name}</span></Link>
          {def.eightWorkerName ? (
            <p className="text-micro text-text-dim">
              On patch 5.0.16 (8 workers) this is labelled{" "}
              <span className="font-medium text-text-muted">{def.eightWorkerName}</span>.
            </p>
          ) : null}
          {guides.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-caption">
              <BookOpen className="h-4 w-4 text-accent-cyan" aria-hidden />
              {guides.map((guide) => (
                <span key={guide.href} className="inline-flex flex-wrap items-center gap-2"><Link
                  key={guide.href}
                  href={guide.href}
                  aria-label={`${guide.matchup} guide for ${def.name}`}
                  className="inline-flex min-h-[36px] items-center font-semibold text-accent-cyan underline-offset-2 hover:text-accent-cyan hover:underline"
                >
                  {guides.length > 1 ? `${guide.matchup} guide` : "Guide"}
                </Link><PracticeButton build={{ name: def.name, race: def.race }} guideHref={guide.href} matchup={guide.matchup} /></span>
              ))}
            </div>
          ) : null}
        </div>
      </article>
    </Card>
  );
}

/** Copies the link to one definition card (`/definitions#<id>`). */
function CopyDefinitionLink({ id, name }: { id: string; name: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const inputId = useId(), helpId = useId();
  const toast = useToastOptional();
  const clipboard = useCopy({
    scopeKey: id,
    onCopied: () => toast?.toast.success("Definition link copied"),
    onFallback: () => toast?.toast.info("Copy the selected definition link"),
  });
  const setInputRef = useCallback((node: HTMLInputElement | null) => { clipboard.inputRef.current = node; }, [clipboard.inputRef]);
  const dismiss = () => { clipboard.clear(); button.current?.focus(); };

  return (
    <><IconButton
      ref={button}
      onClick={() => { void clipboard.copy(`${window.location.origin}/definitions#${id}`); }}
      disabled={clipboard.pending} aria-busy={clipboard.pending}
      aria-label={clipboard.copied ? `Link to ${name} copied` : `Copy link to ${name}`}
      title={clipboard.copied ? "Link copied" : "Copy link"}
      className="shrink-0 text-text-dim hover:text-text"
    >
      {clipboard.copied ? (
        <Check className="h-4 w-4 text-success" aria-hidden />
      ) : (
        <Link2 className="h-4 w-4" aria-hidden />
      )}
    </IconButton>
    <span role="status" className="sr-only">{clipboard.copied ? "Link copied" : clipboard.pending ? "Copying definition link" : clipboard.fallbackText !== null ? "Automatic copy is unavailable. Copy the selected definition link manually." : ""}</span>
    {clipboard.fallbackText !== null ? <div className="col-span-2 min-w-0 space-y-2 rounded-lg border border-border bg-bg-surface p-3">
      <label htmlFor={inputId} className="block text-caption font-semibold">Copy definition link manually</label>
      <Input ref={setInputRef} id={inputId} value={clipboard.fallbackText} readOnly aria-describedby={helpId} className="min-h-11"
        onFocus={event => event.currentTarget.select()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); } }} />
      <p id={helpId} className="text-caption text-text-muted">Press Ctrl+C or ⌘C, or use your browser&apos;s Copy command.</p>
      <Button variant="ghost" size="sm" onClick={dismiss}>Done</Button>
    </div> : null}</>
  );
}
