"use client";

import { useMemo, useState } from "react";
import { BookOpen, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card, EmptyState } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import {
  BUILD_DEFINITIONS,
  DEFINITIONS_TOTAL,
  filterDefinitions,
  type BuildDefinition,
  type StrategyMatchup,
} from "@/lib/build-definitions";
import { raceIconName, raceTint, type Race } from "@/lib/race";

const RACE_FILTERS: ReadonlyArray<{ value: Race | "All"; label: string }> = [
  { value: "All", label: "All" },
  { value: "Protoss", label: "Protoss" },
  { value: "Terran", label: "Terran" },
  { value: "Zerg", label: "Zerg" },
];

const MATCHUP_FILTERS_BY_RACE: Record<
  Race | "All",
  ReadonlyArray<{ value: StrategyMatchup | "All"; label: string }>
> = {
  All: [{ value: "All", label: "All" }],
  Protoss: [
    { value: "All", label: "All" },
    { value: "PvP", label: "PvP" },
    { value: "PvT", label: "PvT" },
    { value: "PvZ", label: "PvZ" },
  ],
  Terran: [
    { value: "All", label: "All" },
    { value: "TvP", label: "TvP" },
    { value: "TvT", label: "TvT" },
    { value: "TvZ", label: "TvZ" },
  ],
  Zerg: [
    { value: "All", label: "All" },
    { value: "ZvP", label: "ZvP" },
    { value: "ZvT", label: "ZvT" },
    { value: "ZvZ", label: "ZvZ" },
  ],
  Random: [{ value: "All", label: "All" }],
};

/**
 * DefinitionsCatalog — interactive list of the 101 build / strategy
 * detection rules. The race + matchup pills compose with a free-text
 * search across name and description.
 */
export function DefinitionsCatalog() {
  const [query, setQuery] = useState("");
  const [race, setRace] = useState<Race | "All">("All");
  const [matchup, setMatchup] = useState<StrategyMatchup | "All">("All");

  const matchups = MATCHUP_FILTERS_BY_RACE[race];

  const filtered = useMemo(
    () => filterDefinitions(BUILD_DEFINITIONS, query, race, matchup),
    [query, race, matchup],
  );

  function clear() {
    setQuery("");
    setRace("All");
    setMatchup("All");
  }

  return (
    <div className="space-y-5">
      <Card>
        <div className="space-y-3">
          <Field label="Search builds and strategies" htmlFor="def-search">
            <div className="relative">
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
          <div role="radiogroup" aria-label="Filter by race" className="flex flex-wrap gap-1.5">
            {RACE_FILTERS.map(({ value, label }) => {
              const active = race === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setRace(value);
                    setMatchup("All");
                  }}
                  className={[
                    "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-caption font-medium",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                    active
                      ? "border-accent-cyan/60 bg-accent-cyan/15 text-accent-cyan"
                      : "border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text",
                  ].join(" ")}
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
                </button>
              );
            })}
          </div>
          {matchups.length > 1 ? (
            <div role="radiogroup" aria-label="Filter by matchup" className="flex flex-wrap gap-1.5">
              {matchups.map(({ value, label }) => {
                const active = matchup === value;
                return (
                  <button
                    key={String(value)}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setMatchup(value)}
                    className={[
                      "inline-flex min-h-[36px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-mono text-caption",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                      active
                        ? "border-accent/40 bg-accent/15 text-accent"
                        : "border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 text-caption text-text-dim">
            <span aria-live="polite">
              <span className="text-text">{filtered.length}</span> of{" "}
              {DEFINITIONS_TOTAL} entries
            </span>
            {query || race !== "All" || matchup !== "All" ? (
              <button
                type="button"
                onClick={clear}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-border bg-bg-elevated px-3 text-caption text-text-muted hover:border-border-strong hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
        <ul className="space-y-2">
          {filtered.map((def) => (
            <li key={def.id}>
              <DefinitionCard def={def} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DefinitionCard({ def }: { def: BuildDefinition }) {
  const tint = raceTint(def.race);
  return (
    <Card variant="default" padded={false}>
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
          <h3 className="text-body font-semibold text-text">{def.name}</h3>
          <p className="text-caption text-text-muted">{def.description}</p>
        </div>
      </article>
    </Card>
  );
}

export function DefinitionsHeaderHint() {
  return (
    <p className="inline-flex items-center gap-1.5 text-caption text-text-muted">
      <BookOpen className="h-4 w-4 text-accent-cyan" aria-hidden />
      The detection rules used by the analyzer to label opponent strategies and
      your own builds. Use these to interpret labels in the rest of the app.
    </p>
  );
}
