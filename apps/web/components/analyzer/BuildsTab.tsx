"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Download, RefreshCcw } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useFilters, filtersToQuery, describeActiveFilters, normalizeRaceCode, withOppRace } from "@/lib/filterContext";
import { csvFilename, downloadCsv, toCsv, type CsvColumn } from "@/lib/csvExport";
import { useLocalStoragePositiveInt, useLocalStorageState } from "@/lib/useLocalStorageState";
import { isMechanicsBucket, type MechanicsBucket } from "@/lib/mechanicsTrend";
import { MixOverTimeChart } from "./charts/MixOverTimeChart";
import { pct1, wrColor } from "@/lib/format";
import { checkinsText } from "@/lib/buildIntent";
import { Card, Skeleton, WrBar } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { usePersistentSort, SortableTh } from "@/components/ui/SortableTh";
import { MinGamesPicker } from "@/components/ui/MinGamesPicker";
import { WinRateSortToggle } from "@/components/ui/WinRateSortToggle";
import { BuildEditorModal } from "./BuildEditorModal";
import { StrengthCell, StrengthGuide, StrengthHeader, WinRateRange } from "./StrengthAdjusted";
import type { StrengthFields } from "@/lib/strengthAdjusted";
import { NoFilterMatches } from "./EmptyStates";
import { BuildMmrPanel } from "./mmr/BuildMmrPanel";
import { BuildAgingCurve } from "./mmr/BuildAgingCurve";
import { MmrProgressionByBuild } from "./mmr/MmrProgressionByBuild";

type BuildRow = StrengthFields & {
  name: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  myMatchups?: Record<string, number>;
  /** Games counted here only because of a confirmed build check-in. */
  checkins?: number;
};

const LS_MIN_BUILDS = "analyzer.builds.minGames";
const LS_BUILDS_SORT = "analyzer.builds.sort";
const BUILD_COLUMNS: readonly (CsvColumn<BuildRow> & { sortKey?: string; strength?: boolean })[] = [
  { key: "name", label: "Build", sortKey: "name" },
  { key: "wins", label: "W", sortKey: "wins" },
  { key: "losses", label: "L", sortKey: "losses" },
  { key: "total", label: "Games", sortKey: "total" },
  { key: "winRate", label: "WR", sortKey: "winRate" },
  { key: "winsAboveExpected", label: "Vs expected", strength: true,
    format: (value, row) => (row.ratedGames ?? 0) > 0 && typeof value === "number" && Number.isFinite(value) ? value : null },
  { key: "wlSplit", label: "W/L split", format: (_value, row) => `${row.wins}W ${row.losses}L` },
];

/** Custom and detected builds share the same filtered replay statistics. */
export function BuildsTab({ search: controlledSearch, onSearchChange }: { search?: string; onSearchChange?: (value: string) => void } = {}) {
  const { filters, setFilters, dbRev, seasons } = useFilters();
  const [localSearch, setLocalSearch] = useState("");
  const search = controlledSearch ?? localSearch;
  const setSearch = (value: string) => { setLocalSearch(value); onSearchChange?.(value); };
  const [minGames, setMinGames] = useLocalStoragePositiveInt(LS_MIN_BUILDS, 1);
  const [editing, setEditing] = useState<string | null>(null);
  const [bucket, setBucket] = useLocalStorageState<MechanicsBucket>("analyzer.trends.bucket", "week", isMechanicsBucket);
  const sort = usePersistentSort(LS_BUILDS_SORT, "total", "desc");

  const { data, isLoading, error, mutate } = useApi<BuildRow[]>(
    `/v1/builds${filtersToQuery(filters)}#${dbRev}`,
    { keepPreviousData: false },
  );

  const rows = useMemo(() => {
    let r = (data || []).filter((b) => b.total > 0);
    const s = search.trim().toLowerCase();
    if (s) r = r.filter((b) => b.name.toLowerCase().includes(s));
    if (minGames > 1) r = r.filter((b) => (b.total || 0) >= minGames);
    return sort.sortRows(r, (row, col) => (row as any)[col]);
  }, [data, search, minGames, sort]);

  const hiddenByMinGames = useMemo(() => {
    if (minGames <= 1) return 0;
    const all = (data || []).filter((b) => b.total > 0);
    const s = search.trim().toLowerCase();
    const matchedSearch = s
      ? all.filter((b) => b.name.toLowerCase().includes(s))
      : all;
    return matchedSearch.filter((b) => (b.total || 0) < minGames).length;
  }, [data, search, minGames]);

  const exportRows = () => {
    const exportedAt = new Date();
    const globalScope = describeActiveFilters(filters, { seasons }).map(item => `${item.label}: ${item.value}`).join(" · ") || "Default filters";
    const scope = `Builds · ${globalScope} · search ${search.trim() || "(none)"} · min games ${minGames} · sort ${sort.sortBy} ${sort.sortDir}${error ? " · last loaded results (refresh failed)" : ""}`;
    downloadCsv(csvFilename("builds", exportedAt), toCsv({ columns: BUILD_COLUMNS, rows, scope, exportedAt }));
  };

  if (isLoading && !error) return <Skeleton rows={6} />;

  return (
    <div className="space-y-4">
      {error && data ? (
        <Card role="alert">
          <p className="text-caption text-text-muted">
            Couldn&apos;t refresh builds. Showing the last loaded results for these filters.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void mutate()}>Retry</Button>
        </Card>
      ) : error ? (
        <RequestError error={error} onRetry={() => mutate()} filtered />
      ) : null}
      <ReclassifyBanner rows={data || []} />
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Search builds"
          className="min-h-11"
          placeholder="Search builds"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MinGamesPicker value={minGames} onChange={setMinGames} />
        <button type="button" className="min-h-11 rounded-lg border border-border px-3 text-caption" aria-pressed={sort.sortBy === "winsAboveExpected"} onClick={() => sort.setSortExplicit("winsAboveExpected", sort.sortBy === "winsAboveExpected" && sort.sortDir === "desc" ? "asc" : "desc")}>Vs expected {sort.sortBy === "winsAboveExpected" ? sort.sortDir === "desc" ? "↓" : "↑" : ""}</button>
        <WinRateSortToggle
          dir={sort.sortBy === "winRate" ? sort.sortDir : "desc"}
          active={sort.sortBy === "winRate"}
          onChange={(dir) => sort.setSortExplicit("winRate", dir)}
        />
        <span className="text-xs text-text-dim">
          Select a build to view or edit it
        </span>
      </div>

      {data || !error ? <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><StrengthGuide />
          <Button variant="ghost" size="sm" aria-label={rows.length ? "Export these rows as CSV" : "Nothing to export"} disabled={!rows.length} onClick={exportRows} iconLeft={<Download aria-hidden className="h-4 w-4" />}>{rows.length ? "Export CSV" : "Nothing to export"}</Button>
        </div>
        {rows.length === 0 ? (
          <NoFilterMatches
            title="No builds match these filters"
            minGames={minGames}
            hiddenByMinGames={hiddenByMinGames}
            onLowerMinGames={() => setMinGames(1)}
            extraAction={
              search.trim() ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            {/* Mobile (< md): stacked cards per row so the build name
                stays fully readable. The desktop table-fixed layout
                below keeps the four numeric columns from grabbing
                leftover space and pushing WR off-screen, but on a
                phone viewport even the build column itself collapses,
                so swap to a vertical card on small screens. */}
            <ul className="space-y-2 md:hidden">
              {rows.map((b) => (
                <li key={b.name}>
                  <div
                    className="flex w-full flex-col gap-1.5 rounded-xl border-2 border-line bg-bg-surface px-3 py-2 text-left shadow-hard transition hover:border-accent hover:bg-accent/10"
                  >
                    <button type="button" onClick={() => setEditing(b.name)} className="min-h-11 rounded text-left text-sm font-semibold text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      {b.name}
                    </button>
                    <MatchupChips counts={b.myMatchups} selected={filters.opp_race} onSelect={race => setFilters(withOppRace(filters, race))} />
                    <CheckinsNote count={b.checkins} />
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                      <span className="text-success">{b.wins}W</span>
                      <span className="text-danger">{b.losses}L</span>
                      <span className="text-text-muted">
                        {b.total} games
                      </span>
                      <span
                        className="font-semibold"
                        style={{ color: wrColor(b.winRate, b.total) }}
                      >
                        {pct1(b.winRate)}
                      </span>
                    </div>
                    <div className="w-full">
                      <WrBar wins={b.wins} losses={b.losses} />
                    </div>
                    <WinRateRange row={b} total={b.total} />
                    <StrengthCell row={b} />
                  </div>
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:block">
              {/* ``table-fixed`` + explicit colgroup widths so the four
                  numeric cols don't grab equal shares of leftover space
                  and push WR off the right edge — see StrategiesTabBuildVs
                  for the same treatment. */}
              <table className="w-full min-w-[40rem] table-fixed text-sm">
                <colgroup>
                  <col />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "3.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "4.5rem" }} />
                  <col style={{ width: "8rem" }} />
                  <col style={{ width: "8rem" }} />
                </colgroup>
                <thead className="bg-bg-elevated">
                  <tr>
                    {BUILD_COLUMNS.map(column => column.strength ? <StrengthHeader key={String(column.key)} sort={sort} />
                      : column.sortKey ? <SortableTh key={String(column.key)} col={column.sortKey} label={column.label} {...sort} align={column.sortKey === "name" ? "left" : "right"} />
                      : <th key={String(column.key)} className="px-3 py-2 text-left text-micro uppercase text-text-dim">{column.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <tr
                      key={b.name}
                      className="cursor-pointer border-t border-border hover:bg-accent/10"
                      onClick={() => setEditing(b.name)}
                    >
                      <td className="px-3 py-1.5 text-text">
                        <button type="button" onClick={event => { event.stopPropagation(); setEditing(b.name); }} title={b.name} className="block min-h-11 max-w-full truncate rounded text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{b.name}</button>
                        <MatchupChips counts={b.myMatchups} selected={filters.opp_race} onSelect={race => setFilters(withOppRace(filters, race))} />
                        <CheckinsNote count={b.checkins} inline />
                      </td>
                      <td className="px-2 py-1.5 text-right text-success">{b.wins}</td>
                      <td className="px-2 py-1.5 text-right text-danger">{b.losses}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{b.total}</td>
                      <td
                        className="px-2 py-1.5 text-right tabular-nums"
                        style={{ color: wrColor(b.winRate, b.total) }}
                      >
                        {pct1(b.winRate)}
                        <WinRateRange row={b} total={b.total} />
                      </td>
                      <td className="px-2 py-1.5 text-right"><StrengthCell row={b} /></td>
                      <td className="px-3 py-1.5">
                        <WrBar wins={b.wins} losses={b.losses} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card> : null}

      <BuildMmrPanel />
      <div className="space-y-2"><label className="flex items-center gap-2 text-caption text-text-muted">Group build mix by<select aria-label="Build mix period" value={bucket} onChange={event => setBucket(event.target.value as MechanicsBucket)} className="min-h-11 rounded-md border border-border bg-bg-surface px-2 text-text"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></label><MixOverTimeChart endpoint="timeseries/my-builds" title="Build mix over time" caption="Recorded game counts per build and calendar period." bucket={bucket} /></div>

      {/* ``[&>*]:min-w-0`` style applied per-child below — see each
          chart wrapper. Without it the long build labels in the chart
          legends push their column wider than the grid track and the
          row overflows the page horizontally. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <BuildAgingCurve />
        </div>
        <div className="min-w-0">
          <MmrProgressionByBuild />
        </div>
      </div>

      {editing && (
        <BuildEditorModal
          buildName={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function MatchupChips({ counts, selected, onSelect }: {
  counts?: Record<string, number>; selected?: string; onSelect: (race: string) => void;
}) {
  if (!counts) return null;
  const races = [{ code: "P", name: "Protoss" }, { code: "T", name: "Terran" }, { code: "Z", name: "Zerg" }];
  const chips = races.flatMap(race => {
    const games = counts[race.code] ?? counts[race.name] ?? counts[race.name.toLowerCase()];
    return Number.isSafeInteger(games) && games > 0 ? [{ ...race, games }] : [];
  }).sort((a, b) => b.games - a.games);
  if (!chips.length) return null;
  return <div className="flex flex-wrap gap-1" aria-label="Build matchups">
    {chips.map(race => <button key={race.code} type="button" aria-label={`Filter builds vs ${race.name}: ${race.games} games`} aria-pressed={normalizeRaceCode(selected) === race.code}
      onClick={event => { event.stopPropagation(); onSelect(race.code); }}
      className="min-h-11 rounded border border-border px-2 text-caption text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">v{race.code} {race.games}</button>)}
  </div>;
}

/** "incl. N check-ins" — games counted only because of a confirmed check-in. */
function CheckinsNote({ count, inline = false }: { count?: number; inline?: boolean }) {
  const text = checkinsText(count);
  if (!text) return null;
  return (
    <span
      className={[
        "text-micro text-text-dim",
        inline ? "ml-2" : "block",
      ].join(" ")}
      title="Games you checked in to this build that the replay classified as something else"
    >
      {text}
    </span>
  );
}

/**
 * Offer a one-click relabel when stored games carry the
 * "Unclassified - Zerg/Terran" sentinel — uploads that predate the
 * Zerg/Terran build detectors (agent < 0.11) or the expanded ZvP/TvP
 * trees. The existing force-backfill endpoint runs the same full
 * resync the tray's Re-sync button does: the agent re-parses every
 * replay on disk with the current classifier and the ingest upsert
 * refreshes each game's build label.
 */
function ReclassifyBanner({ rows }: { rows: BuildRow[] }) {
  const { getToken } = useAuth();
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staleCount = useMemo(
    () =>
      rows
        .filter((b) => b.name.startsWith("Unclassified - "))
        .reduce((sum, b) => sum + (b.total || 0), 0),
    [rows],
  );

  if (staleCount === 0) return null;

  async function reclassify() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiCall(getToken, "/v1/macro/backfill/start", {
        method: "POST",
        body: JSON.stringify({ force: true, reason: "build_reclassify" }),
      });
      setRequested(true);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message || "Couldn't request the reclassify.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-warning/40 bg-warning/5 px-4 py-3">
      <p className="text-caption text-text">
        <span className="font-semibold">
          {staleCount.toLocaleString()} game{staleCount === 1 ? "" : "s"} have
          no build classification.
        </span>{" "}
        <span className="text-text-muted">
          They were uploaded before Zerg/Terran build detection existed —
          your desktop agent can re-parse and relabel them.
        </span>
      </p>
      {requested ? (
        <span className="text-caption text-success">
          Requested — if your agent is online it&apos;s re-uploading now.
          Labels refresh as games land.
        </span>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void reclassify()}
          disabled={busy}
          loading={busy}
          iconLeft={<RefreshCcw className="h-3.5 w-3.5" aria-hidden />}
        >
          Reclassify my games
        </Button>
      )}
      {error ? (
        <p className="w-full text-caption text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
