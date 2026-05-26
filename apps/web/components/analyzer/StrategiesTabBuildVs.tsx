"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { useSort, SortableTh } from "@/components/ui/SortableTh";
import { WinRateSortToggle } from "@/components/ui/WinRateSortToggle";
import { PhaseTrajectoryStrip } from "./PhaseTrajectoryStrip";
import {
  PhaseCompositionTabs,
  type Phase,
  type PhaseCompositionRow,
} from "./PhaseCompositionTabs";
import type { CustomBuild } from "@/components/builds/types";
import type { BuildPhasePayload } from "@/lib/serverApi";

/**
 * Build × Opponent-strategy matrix for ``StrategiesTab``.
 *
 * Pulled out so ``StrategiesTab.tsx`` stays under the 800-line cap.
 * The view, MinGames threshold, and view-mode preferences are
 * persisted to localStorage by the parent — this file owns only the
 * presentational matrix + table renderers.
 */

export type BvsCell = {
  my_build: string;
  opp_strat: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

export interface BuildVsStrategyViewProps {
  onOpenBvs: (build: string, strategy: string) => void;
  /** Current view mode — fully controlled by the caller. */
  initialView: "heatmap" | "table";
  /** Current min-games threshold — fully controlled by the caller. */
  initialMinGames: number;
  /** Setter invoked when the user flips the view mode. */
  onViewChange: (view: "heatmap" | "table") => void;
  /** Setter invoked when the user adjusts the threshold. */
  onMinGamesChange: (n: number) => void;
  /** MinGames picker rendered above the matrix — supplied by the
   *  parent so the same control is shared with the by-strategy view. */
  renderMinGamesPicker: (
    value: number,
    onChange: (n: number) => void,
  ) => React.ReactNode;
}

export function BuildVsStrategyView({
  onOpenBvs,
  initialView,
  initialMinGames,
  onViewChange,
  onMinGamesChange,
  renderMinGamesPicker,
}: BuildVsStrategyViewProps) {
  const { filters, dbRev } = useFilters();
  const [search, setSearch] = useState("");
  // Fully controlled: ``view`` / ``minGames`` are owned by the parent
  // so localStorage hydration in StrategiesTab (via
  // ``useLocalStorageState``) flows straight through. Re-introducing
  // local copies under ``useState(initialFoo)`` was the source of a
  // hydration desync — the inner state captured the pre-hydration
  // default and never picked up the user's saved value.
  const view = initialView;
  const setView = onViewChange;
  const minGames = initialMinGames;
  const setMinGames = onMinGamesChange;
  const sort = useSort("total", "desc");

  const { data, isLoading } = useApi<BvsCell[]>(
    `/v1/build-vs-strategy${filtersToQuery(filters)}#${dbRev}`,
  );

  const filtered = useMemo(() => {
    let r = data || [];
    const s = search.trim().toLowerCase();
    if (s) {
      r = r.filter(
        (x) =>
          (x.my_build || "").toLowerCase().includes(s) ||
          (x.opp_strat || "").toLowerCase().includes(s),
      );
    }
    if (minGames > 1) r = r.filter((x) => (x.total || 0) >= minGames);
    return r;
  }, [data, search, minGames]);

  const rows = useMemo(
    () =>
      sort.sortRows(filtered, (row, col) => (row as Record<string, unknown>)[col]),
    [filtered, sort],
  );

  if (isLoading) return <Skeleton rows={8} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-72"
          placeholder="search build or strategy…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {renderMinGamesPicker(minGames, setMinGames)}
        {view === "table" ? (
          <WinRateSortToggle
            dir={sort.sortBy === "winRate" ? sort.sortDir : "desc"}
            active={sort.sortBy === "winRate"}
            onChange={(dir) => sort.setSortExplicit("winRate", dir)}
          />
        ) : null}
        <div className="inline-flex overflow-hidden rounded border border-border">
          {(["table", "heatmap"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs capitalize transition ${
                view === v
                  ? "bg-accent/20 text-accent"
                  : "text-text-muted hover:bg-bg-elevated"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div className="text-[11px] text-text-dim">
        Click any cell or row to see the games for that build × strategy combo.
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState title="Not enough samples" />
        </Card>
      ) : view === "heatmap" ? (
        <BvsHeatmap rows={filtered} onOpenBvs={onOpenBvs} />
      ) : (
        <BvsTable rows={rows} sort={sort} onOpenBvs={onOpenBvs} />
      )}
    </div>
  );
}

function BvsHeatmap({
  rows,
  onOpenBvs,
}: {
  rows: BvsCell[];
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  const builds = useMemo(
    () => Array.from(new Set(rows.map((r) => r.my_build))).sort(),
    [rows],
  );
  const strategies = useMemo(
    () => Array.from(new Set(rows.map((r) => r.opp_strat))).sort(),
    [rows],
  );
  const lookup = useMemo(() => {
    const m = new Map<string, BvsCell>();
    for (const r of rows) m.set(`${r.my_build}|${r.opp_strat}`, r);
    return m;
  }, [rows]);
  const maxGames = Math.max(...rows.map((r) => r.total || 0), 1);

  if (builds.length === 0 || strategies.length === 0) {
    return (
      <Card>
        <EmptyState title="Not enough samples" />
      </Card>
    );
  }

  return (
    <Card>
      <div className="overflow-auto">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-bg-surface px-2 py-1 text-left text-text-dim">
                My build ↓ / vs →
              </th>
              {strategies.map((s) => (
                <th
                  key={s}
                  className="px-1 py-1 align-bottom text-text-muted"
                  style={{ minWidth: "5.5rem", maxWidth: "8rem" }}
                >
                  <div className="truncate" title={s}>
                    {s}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {builds.map((b) => (
              <tr key={b}>
                <td
                  className="sticky left-0 truncate bg-bg-surface px-2 py-1 text-text"
                  style={{ maxWidth: "12rem" }}
                  title={b}
                >
                  {b}
                </td>
                {strategies.map((s) => {
                  const c = lookup.get(`${b}|${s}`);
                  if (!c) {
                    return (
                      <td key={s} className="px-0.5 py-0.5">
                        <div className="h-9 rounded bg-bg-elevated/40" />
                      </td>
                    );
                  }
                  const intensity = 0.35 + 0.65 * (c.total / maxGames);
                  return (
                    <td key={s} className="px-0.5 py-0.5">
                      <button
                        type="button"
                        onClick={() => onOpenBvs(b, s)}
                        className="flex h-9 w-full cursor-pointer items-center justify-center rounded text-[11px] font-semibold tabular-nums ring-1 ring-inset ring-black/30 transition hover:ring-2 hover:ring-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        style={{
                          background: wrColor(c.winRate, c.total),
                          opacity: intensity,
                          color: "#0c0c0c",
                        }}
                        title={`${b} vs ${s}\n${c.wins}W - ${c.losses}L · ${c.total} games · ${pct1(c.winRate)}\nClick to see the games.`}
                      >
                        {pct1(c.winRate).replace(".0", "")}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-text-dim">
          Cell color = win rate. Cell opacity = sample size. Click a cell to see the games.
        </div>
      </div>
    </Card>
  );
}

/**
 * Response shape of GET ``/v1/strategies/:name/phases`` — the payload
 * the right column ("what they typically do") reads from. Declared
 * locally so this file stays self-contained.
 */
type StrategyPhasesResponse = {
  name: string;
  total: number;
  perspective: "you" | "opponent";
  sampleSize: Record<Phase, number>;
  perPhase: Record<Phase, PhaseCompositionRow>;
  finalPhaseDistribution: Record<Phase, number>;
  medianCrossings: {
    earlyMidAt: number | null;
    midAt: number | null;
    midLateAt: number | null;
    lateAt: number | null;
  };
  durationP95Sec: number;
  flags: string[];
};

const COMPARISON_MIN_GAMES = 3;

/**
 * Strip the leading race-matchup prefix from a build label. The agent's
 * auto-classifier produces names like "PvZ - 3 Stargate Phoenix" — the
 * "PvZ - " segment encodes (your race)(v)(opp race) and shouldn't
 * participate in name comparisons against saved custom-build names,
 * which users typically author without that prefix. The character class
 * covers P/T/Z/R (case-insensitive); the separator may be a hyphen,
 * en-dash or em-dash with arbitrary surrounding whitespace, or just
 * whitespace alone — users sometimes save builds as "PvZ Stargate"
 * without the dash.
 */
function stripMatchupPrefix(s: string): string {
  return s.replace(/^[PTZR]v[PTZR](\s*[-–—]\s*|\s+)/i, "");
}

/**
 * Normalize a build name for slug-bridge comparison: strip the matchup
 * prefix, trim, lowercase, and collapse internal whitespace. The agent
 * label is generated mechanically while user-saved names are typed by
 * hand — equality should tolerate case + whitespace drift.
 */
function normalizeBuildName(s: string): string {
  return stripMatchupPrefix(s).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * BuildVsStrategyComparison — side-by-side phase trajectory + per-
 * phase composition for the drill-down view of "my build × their
 * strategy". Left column is the user's perspective on their saved
 * build; right column is the opponent's perspective on the
 * detected strategy. Each column reuses the same trajectory strip /
 * composition tabs the BuildDossier surface — agnostic by design,
 * only the perspective and aggregation key differ.
 *
 * Empty states are independent per column: a brand-new build with
 * no games still renders the right column if the opponent strategy
 * has enough samples. When the build doesn't map to a saved custom
 * build (e.g. the agent's auto-classifier label), the left column
 * surfaces the unmatched-build EmptyState rather than guessing a
 * slug.
 */
export function BuildVsStrategyComparison({
  build,
  strategy,
}: {
  build: string;
  strategy: string;
}) {
  // Resolve build name → custom-build slug via the user's library.
  // The drill state only carries the display name (matches ``myBuild``
  // on the game record); custom-build endpoints key on slug, so we
  // bridge here. The agent's auto-classifier emits race-matchup-
  // prefixed labels ("PvZ - 3 Stargate Phoenix") whereas the user
  // typically saves the build without that prefix ("3 Stargate
  // Phoenix"), so we normalize both sides before comparing — otherwise
  // every drill from a build × strategy cell falls back to the empty
  // state even when the user has data on that build.
  const customBuilds = useApi<{ items: CustomBuild[] } | CustomBuild[]>(
    "/v1/custom-builds",
  );
  const slug = useMemo(() => {
    const list = Array.isArray(customBuilds.data)
      ? customBuilds.data
      : customBuilds.data?.items ?? [];
    const target = normalizeBuildName(build);
    const hit = list.find((b) => {
      const candidate = normalizeBuildName(b.name || b.slug || "");
      return candidate === target;
    });
    return hit?.slug || null;
  }, [customBuilds.data, build]);
  // While the custom-builds list is in flight, ``slug`` is null but the
  // user may well have a matching build — gate the empty state on the
  // fetch settling so we don't flash "No saved build for this label"
  // (or worse, leave it on a stale render) before the bridge resolves.
  const slugLoading = !customBuilds.data && !customBuilds.error;

  return (
    <Card title="Build vs strategy — phase comparison">
      <p className="mb-3 text-[11px] text-text-dim">
        Both sides describe the SAME games — the ones where you played
        this build and the opponent played this strategy. Left is your
        trajectory, right is theirs. Compare the crossings to see who
        gets to late game first — and with what.
      </p>
      <div
        className="grid grid-cols-1 gap-3 xl:grid-cols-2 xl:gap-4"
        data-testid="build-vs-strategy-comparison"
      >
        <ComparisonColumn
          title="What you typically do"
          subtitle={build}
          testId="bvs-column-you"
        >
          <YouColumn
            build={build}
            strategy={strategy}
            slug={slug}
            isResolvingSlug={slugLoading}
          />
        </ComparisonColumn>
        <ComparisonColumn
          title="What they typically do"
          subtitle={strategy}
          testId="bvs-column-opponent"
        >
          <OpponentColumn strategy={strategy} build={build} />
        </ComparisonColumn>
      </div>
    </Card>
  );
}

function ComparisonColumn({
  title,
  subtitle,
  testId,
  children,
}: {
  title: string;
  subtitle: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    // ``min-w-0`` is what lets the grid track shrink below its intrinsic
    // content size. Without it the long ``subtitle`` (build / strategy
    // name with ``truncate``) forces this section wider than its grid
    // column at xl, and the whole panel overflows the page. Inner
    // padding is intentionally tighter than the parent Card's ``p-4``
    // so two columns of composition cards still fit comfortably at
    // common 1280–1440px desktop widths after the Card padding +
    // sidebar gutter eat their share.
    <section
      className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-surface p-3"
      data-testid={testId}
    >
      <header className="min-w-0">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text">
          {title}
        </h3>
        <p className="truncate text-[11px] text-text-muted" title={subtitle}>
          {subtitle}
        </p>
      </header>
      {children}
    </section>
  );
}

function YouColumn({
  build,
  strategy,
  slug,
  isResolvingSlug,
}: {
  build: string;
  strategy: string;
  slug: string | null;
  isResolvingSlug: boolean;
}) {
  // Left side has two data sources, picked in priority order:
  //
  // 1. Saved custom build (``/v1/custom-builds/:slug/compositions``)
  //    — when the user has explicitly saved a matching build, its
  //    rule-driven match set is the most authoritative answer.
  // 2. Agent-classified build label (``/v1/builds/:name/phases``) —
  //    the fallback for labels the agent auto-detected but the user
  //    never saved. Filters games by ``myBuild === build`` so the
  //    left column still renders against the 17W-7L set of games
  //    that powered the drill in the first place.
  //
  // Both endpoints return the same envelope shape so
  // ``ComparisonBody`` can render either without branching.
  //
  // The ``strategy`` axis is forwarded so the matched set is
  // additionally scoped to the cell the user clicked — without it,
  // the left column reports the build's marginal across every
  // opponent strategy (often orders of magnitude larger than the
  // cell), which is what made the side-by-side counts incomparable.
  //
  // The global filter bar (timeframe / race / map / mmr / region) is
  // also threaded through so the panel describes the SAME game set as
  // the "All games" list below — without it the column scanned the
  // latest 1000 games regardless of the active timeframe.
  const { filters } = useFilters();
  const filterQuery = filtersToQuery(filters);
  const strategyParam = strategy
    ? `&strategy=${encodeURIComponent(strategy)}`
    : "";
  const phaseParams = `perspective=you${strategyParam}`;
  const phaseQuery = filterQuery
    ? `${filterQuery}&${phaseParams}`
    : `?${phaseParams}`;
  const customPath = slug
    ? `/v1/custom-builds/${encodeURIComponent(slug)}/compositions${phaseQuery}`
    : null;
  const customResult = useApi<BuildPhasePayload>(customPath);

  // Only fire the fallback once the slug bridge has settled and
  // resolved to "no saved build" — firing both in parallel would
  // double up Mongo scans for users who DO have a saved build.
  const labelPath =
    !slug && !isResolvingSlug && build
      ? `/v1/builds/${encodeURIComponent(build)}/phases${phaseQuery}`
      : null;
  const labelResult = useApi<BuildLabelPhasesResponse>(labelPath);

  if (isResolvingSlug) return <Skeleton rows={3} />;

  if (slug) {
    if (customResult.isLoading && !customResult.data) {
      return <Skeleton rows={3} />;
    }
    if (customResult.error) {
      return (
        <EmptyState
          title="Couldn't load this build"
          sub="Phase compositions failed to load for the left column."
        />
      );
    }
    if (!customResult.data) return null;
    return <ComparisonBody payload={customResult.data} />;
  }

  // Auto-classified label fallback
  if (labelResult.isLoading && !labelResult.data) {
    return <Skeleton rows={3} />;
  }
  // 404 is the API's tell for "no games match" — surface the empty
  // state below rather than the generic load-failure copy.
  if (labelResult.error && labelResult.error.status !== 404) {
    return (
      <EmptyState
        title="Couldn't load this build"
        sub="Phase compositions failed to load for the left column."
      />
    );
  }
  if (!labelResult.data || labelResult.data.total < COMPARISON_MIN_GAMES) {
    const total = labelResult.data?.total ?? 0;
    return (
      <EmptyState
        title="Not enough samples"
        sub={
          total > 0
            ? `${total} game${total === 1 ? "" : "s"} so far · the comparison starts at ${COMPARISON_MIN_GAMES}.`
            : "Play a few games with this build to see what you typically do — or save it to your library to lock the signature."
        }
      />
    );
  }
  return <ComparisonBody payload={labelResult.data} />;
}

/**
 * Response shape of GET ``/v1/builds/:name/phases`` — the user-side
 * fallback the left column reads when no saved custom build matches
 * the agent's auto-classified label. Mirrors
 * ``StrategyPhasesResponse`` but keyed on ``myBuild`` rather than
 * ``opponent.strategy``.
 */
type BuildLabelPhasesResponse = {
  name: string;
  total: number;
  perspective: "you" | "opponent";
  sampleSize: Record<Phase, number>;
  perPhase: Record<Phase, PhaseCompositionRow>;
  finalPhaseDistribution: Record<Phase, number>;
  medianCrossings: {
    earlyMidAt: number | null;
    midAt: number | null;
    midLateAt: number | null;
    lateAt: number | null;
  };
  durationP95Sec: number;
  flags: string[];
};

function OpponentColumn({
  strategy,
  build,
}: {
  strategy: string;
  build: string;
}) {
  // ``build`` scopes the strategy aggregation to one cell of the
  // build × strategy matrix — same game set as the cell the user
  // clicked, so both columns render comparable sample sizes. The
  // global filter bar is threaded through so the matched set respects
  // the same timeframe / race / map / mmr / region scoping as the
  // "All games" list below.
  const { filters } = useFilters();
  const filterQuery = filtersToQuery(filters);
  const buildParam = build ? `&build=${encodeURIComponent(build)}` : "";
  const phaseParams = `perspective=opponent${buildParam}`;
  const phaseQuery = filterQuery
    ? `${filterQuery}&${phaseParams}`
    : `?${phaseParams}`;
  const path = strategy
    ? `/v1/strategies/${encodeURIComponent(strategy)}/phases${phaseQuery}`
    : null;
  const { data, isLoading, error } = useApi<StrategyPhasesResponse>(path);

  if (!strategy) {
    return (
      <EmptyState
        title="Pick a strategy"
        sub="The right column needs an opponent strategy to compare against."
      />
    );
  }
  if (isLoading && !data) return <Skeleton rows={3} />;
  // 404 here means the strategy has no qualifying games — surface
  // the empty state and keep the left column rendering.
  if (error && error.status !== 404) {
    return (
      <EmptyState
        title="Couldn't load this strategy"
        sub="Phase compositions failed to load for the right column."
      />
    );
  }
  if (!data || data.total < COMPARISON_MIN_GAMES) {
    return (
      <EmptyState
        title="Not enough samples"
        sub={
          data && data.total > 0
            ? `${data.total} game${data.total === 1 ? "" : "s"} so far · the comparison starts at ${COMPARISON_MIN_GAMES}.`
            : "Play a few games against this strategy to see what they typically do."
        }
      />
    );
  }
  return <ComparisonBody payload={data} />;
}

function ComparisonBody({
  payload,
}: {
  payload: {
    sampleSize: Record<Phase, number>;
    perPhase: Record<Phase, PhaseCompositionRow>;
    finalPhaseDistribution: Record<Phase, number>;
    medianCrossings: {
      earlyMidAt: number | null;
      midAt: number | null;
      midLateAt: number | null;
      lateAt: number | null;
    };
    durationP95Sec: number;
    flags?: string[];
  };
}) {
  // ``opp_signals_sparse`` is the API's tell that >50% of matched
  // games had no opp_stats_events — the trajectory would be noisy
  // and incomplete, so we surface the same EmptyState as the
  // all-zero sampleSize fallback would.
  if (payload.flags && payload.flags.includes("opp_signals_sparse")) {
    return (
      <EmptyState
        title="Opponent signal too sparse"
        sub="Most matched replays are missing the opponent's tracker events — drawing the trajectory here would be misleading."
      />
    );
  }
  return (
    <div className="space-y-4">
      <PhaseTrajectoryStrip
        sampleSize={payload.sampleSize}
        crossings={payload.medianCrossings}
        finalPhaseDistribution={payload.finalPhaseDistribution}
        durationP95Sec={payload.durationP95Sec}
        outcomeOnly
      />
      <PhaseCompositionTabs
        sampleSize={payload.sampleSize}
        perPhase={payload.perPhase}
        preferredPhase="mid"
        showTechRow={false}
      />
    </div>
  );
}

function BvsTable({
  rows,
  sort,
  onOpenBvs,
}: {
  rows: BvsCell[];
  sort: ReturnType<typeof useSort>;
  onOpenBvs: (build: string, strategy: string) => void;
}) {
  return (
    <Card>
      {/* Mobile (< md): stacked cards per row. The desktop table-fixed
          layout below keeps WR from being pushed off-screen on mid-width
          viewports, but on a phone the build / strategy columns still
          collapse to single letters; swap to a vertical card on small
          screens so both names render in full. */}
      <ul className="space-y-2 md:hidden">
        {rows.map((c, i) => (
          <li key={`${c.my_build}-${c.opp_strat}-${i}`}>
            <button
              type="button"
              onClick={() => onOpenBvs(c.my_build, c.opp_strat)}
              className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-bg-surface px-3 py-2 text-left transition hover:bg-bg-elevated/40"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-text-dim">
                  My build
                </span>
                <span className="text-sm font-semibold text-text">
                  {c.my_build}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] uppercase tracking-wider text-text-dim">
                  vs Opponent strategy
                </span>
                <span className="text-sm text-text-muted">
                  {c.opp_strat}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                <span className="text-success">{c.wins}W</span>
                <span className="text-danger">{c.losses}L</span>
                <span className="text-text-muted">{c.total} games</span>
                <span
                  className="font-semibold"
                  style={{ color: wrColor(c.winRate, c.total) }}
                >
                  {pct1(c.winRate)}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        {/* ``table-fixed`` plus an explicit ``colgroup`` is what stops
            the four numeric columns from claiming an equal share of
            leftover space (each ~25 % of the row, with W / L right-
            aligned inside a 300 px-wide cell). With fixed widths,
            numerics pack into their content size and the two text
            columns absorb the rest. */}
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col />
            <col style={{ width: "3.5rem" }} />
            <col style={{ width: "3.5rem" }} />
            <col style={{ width: "4.5rem" }} />
            <col style={{ width: "4.5rem" }} />
          </colgroup>
          <thead className="bg-bg-elevated">
            <tr>
              <SortableTh col="my_build" label="My build" {...sort} />
              <SortableTh col="opp_strat" label="vs Opponent strategy" {...sort} />
              <SortableTh col="wins" label="W" {...sort} align="right" />
              <SortableTh col="losses" label="L" {...sort} align="right" />
              <SortableTh col="total" label="Games" {...sort} align="right" />
              <SortableTh col="winRate" label="WR" {...sort} align="right" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr
                key={`${c.my_build}-${c.opp_strat}-${i}`}
                onClick={() => onOpenBvs(c.my_build, c.opp_strat)}
                className="cursor-pointer border-t border-border hover:bg-bg-elevated/40"
                title="Click to see the games"
              >
                <td className="truncate px-3 py-1.5" title={c.my_build}>
                  {c.my_build}
                </td>
                <td
                  className="truncate px-3 py-1.5 text-text-muted"
                  title={c.opp_strat}
                >
                  {c.opp_strat}
                </td>
                <td className="px-2 py-1.5 text-right text-success">{c.wins}</td>
                <td className="px-2 py-1.5 text-right text-danger">{c.losses}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.total}</td>
                <td
                  className="px-2 py-1.5 text-right tabular-nums"
                  style={{ color: wrColor(c.winRate, c.total) }}
                >
                  {pct1(c.winRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
