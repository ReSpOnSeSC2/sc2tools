"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { filtersToQuery, useFilters, describeActiveFilters, type AnalyzerFilters } from "@/lib/filterContext";
import { useSeasons } from "@/lib/useSeasons";
import { useCurrentMapPool } from "@/lib/useCurrentMapPool";
import { poolMapRows, poolWinRate, rankedRecord, vetoMaps, mapRecord, communityMapRate, VETO_MIN_DECIDED, VETO_PRIOR_GAMES, type MapFormStats, type MapMatchupStats } from "@/lib/mapVeto";
import { pct1 } from "@/lib/format";
import { useGuideMapPool } from "@/lib/useGuideMapPool";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { QueryState } from "@/components/ui/QueryState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { MapVetoTable, POOL_MATCHUPS, poolMatchupLabel, type MapGamesDrill } from "./MapVetoTable";

import { TableCsvButton } from "../TableCsvButton";
import type { CsvColumn } from "@/lib/csvExport";

export function plannerWindowFilters(filters: AnalyzerFilters, window: string, now: number, seasonStart?: string | null): AnalyzerFilters {
  const base = { ...filters, opp_race: undefined };
  if (window === "90d") return { ...base, preset: "custom", since: new Date(now - 90 * 86400_000).toISOString(), until: undefined };
  if (window === "season" && seasonStart && Number.isFinite(Date.parse(seasonStart))) return { ...base, preset: "custom", since: seasonStart, until: undefined };
  return base;
}

function CopyVetoes({ names, matchup }: { names: readonly string[]; matchup: string }) {
  const [copied, setCopied] = useState(false), [fallback, setFallback] = useState(false);
  const text = `Suggested SC2 vetoes${matchup ? ` vs ${matchup}` : ""}: ${names.join(", ")}`;
  return <div className="space-y-2"><Button variant="secondary" disabled={!names.length} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setFallback(false); } catch { setFallback(true); }
  }}>Copy veto list</Button>{copied ? <p role="status" className="text-micro text-success">Veto list copied.</p> : null}{fallback ? <label className="block text-caption text-text-muted">Copy this veto list<textarea readOnly value={text} onFocus={(event) => event.target.select()} className="mt-1 w-full rounded border border-border bg-bg-surface p-2 text-text" /></label> : null}</div>;
}

/** Why fewer vetoes than the chosen count are suggested: too few decided games, or no other map below the pool average. */
function shortfallNote(found: number, eligible: number, matchup: string, averageLabel: string): string {
  if (!eligible) return `No map has ${VETO_MIN_DECIDED} decided games ${matchup ? `vs ${matchup}` : "in this sample"} yet.`;
  const lead = found ? `Only ${found} ${found === 1 ? "veto" : "vetoes"} suggested: no other map` : "No veto suggested: no map";
  return `${lead} with at least ${VETO_MIN_DECIDED} decided games is below your ${matchup ? `vs ${matchup} ` : ""}pool average${averageLabel}.`;
}

export function MapVetoPlanner({ openGames }: { openGames: (drill: MapGamesDrill) => void }) {
  const { filters, dbRev, seasons } = useFilters(); const catalog = useSeasons(); const community = useGuideMapPool();
  // Ladder vetoes apply against every opponent race, so the default ranks all matchups together.
  const [window, setWindow] = useState("filters"), [matchup, setMatchup] = useState(""), [count, setCount] = useState(1);
  const [now] = useState(() => Date.now()); const rawSeasonStart = seasons.find((season) => season.isCurrent)?.start;
  const seasonStart = rawSeasonStart && Number.isFinite(Date.parse(rawSeasonStart)) ? rawSeasonStart : null;
  const activeWindow = window === "season" && !seasonStart ? "filters" : window;
  const scope = useMemo(() => plannerWindowFilters(filters, activeWindow, now, seasonStart), [filters, activeWindow, now, seasonStart]);
  const cells = useApi<MapMatchupStats[]>(`/v1/maps/matchups${filtersToQuery(scope)}#${dbRev}`, { keepPreviousData: false });
  const forms = useApi<MapFormStats[]>(`/v1/maps${filtersToQuery({ ...scope, opp_race: matchup || undefined })}#${dbRev}`, { keepPreviousData: false });
  const pool = useCurrentMapPool(catalog.data); const rows = poolMapRows(pool.maps, cells.isPreviousData ? [] : cells.data ?? [], forms.isPreviousData ? [] : forms.data ?? []);
  const suggested = pool.fresh && !cells.error && !cells.isPreviousData ? vetoMaps(rows, matchup, count) : [];
  const average = poolWinRate(rows, matchup), averageLabel = average === null ? "" : ` (${pct1(average)})`;
  const eligible = rows.filter((row) => (rankedRecord(row, matchup)?.decided ?? 0) >= VETO_MIN_DECIDED).length;
  const mine = filters.race?.[0]?.toUpperCase() ?? "";
  const exportRows = rows.flatMap(row => POOL_MATCHUPS.map(race => {
    const record = race ? row.cells[race] ?? mapRecord() : row.all;
    return { map: row.name, matchup: poolMatchupLabel(race), ...record,
      communityWinRate: communityMapRate(community.data?.maps ?? [], row.name, mine, race),
      suggestedVeto: suggested.includes(row.name), recent: row.recent?.join(" ") ?? "" };
  }));
  const exportColumns: CsvColumn<(typeof exportRows)[number]>[] = [
    { key: "map", label: "Map" }, { key: "matchup", label: "Matchup" }, { key: "wins", label: "W" }, { key: "losses", label: "L" },
    { key: "total", label: "Games" }, { key: "decided", label: "Decided games" }, { key: "winRate", label: "WR" },
    { key: "communityWinRate", label: "Community WR" }, { key: "suggestedVeto", label: "Suggested veto" }, { key: "recent", label: "Recent (ranking matchup)" },
  ];
  const exportScope = `Current ladder pool · ${describeActiveFilters(scope, { seasons }).map(item => `${item.label}: ${item.value}`).join(" · ") || "Default filters"} · window ${activeWindow} · ranking ${poolMatchupLabel(matchup)} · veto count ${count}, maps below the pool average${averageLabel} with at least ${VETO_MIN_DECIDED} decided, ranked with ${VETO_PRIOR_GAMES} added games at that average · pool ${pool.source}, fetched ${pool.fetchedAt ? new Date(pool.fetchedAt).toISOString() : "unknown"} · displayed P/T/Z/All columns`;
  return <Card title="Current ladder pool" right={<div className="flex flex-wrap items-center gap-2"><TableCsvButton section="map-pool" rows={exportRows} columns={exportColumns} scope={exportScope} disabled={!cells.data || !!cells.error || cells.isPreviousData || !pool.maps.length} /><LazyHelpLink slug="maps">How to use</LazyHelpLink></div>} className="min-w-0">
    <div className="mb-4 grid gap-3 sm:grid-cols-3"><label className="text-caption font-semibold text-text">Ranking matchup<Select value={matchup} onChange={(event) => setMatchup(event.target.value)}><option value="">All matchups</option>{["P", "T", "Z"].map((race) => <option key={race} value={race}>vs {race}</option>)}</Select></label>
      <label className="text-caption font-semibold text-text">Sample window<Select value={activeWindow} onChange={(event) => setWindow(event.target.value)}><option value="filters">Filter range</option><option value="90d">Last 90 days</option><option value="season" disabled={!seasonStart}>Current season</option></Select></label>
      <label className="text-caption font-semibold text-text">Veto count<Select value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1, 2, 3].map((amount) => <option key={amount} value={amount}>{amount}</option>)}</Select></label></div>
    <QueryState q={catalog} errorTitle="Couldn't load the ladder pool" isEmpty={() => !pool.maps.length} empty={<p className="text-caption text-text-muted">No ladder pool is available yet.</p>}>
      {() => <div className="space-y-3"><p className="text-micro text-text-muted">Pool source: {pool.source === "persisted" ? "persisted snapshot" : pool.source} · {pool.age === null ? "age unavailable" : `${Math.floor(pool.age / 86400_000)} days old`}{pool.fetchedAt ? ` · fetched ${new Date(pool.fetchedAt).toLocaleDateString()}` : ""}</p>
        {!pool.fresh ? <p role="status" className="text-caption text-warning">Pool data may be out of date. Suggestions and copying stay unavailable until a fresh pool is available.</p> : null}
        <p className="text-caption text-text-muted">{matchup ? `Suggested veto marks your lowest win rates vs ${matchup} only. Ladder vetoes apply against every opponent race, so All matchups ranks them together.` : "Suggested veto marks your lowest win rates across all matchups, because ladder vetoes apply against every opponent race."} Each rate is adjusted for sample size, as if the map had {VETO_PRIOR_GAMES} more games at your {matchup ? `vs ${matchup} ` : ""}pool average{averageLabel}, so a short run can&apos;t outrank a long record. A map needs at least {VETO_MIN_DECIDED} decided games and a win rate below that average, since vetoing a stronger map would lower your expected win rate. Other active filters apply, except opponent race.</p>
        <QueryState q={cells} errorTitle="Couldn't load your map sample" filtered isEmpty={() => false}>{() => <MapVetoTable rows={rows} suggested={suggested} matchup={matchup} mine={mine} community={community.data?.maps ?? []} openGames={(drill) => openGames({ ...drill, filters: scope })} />}</QueryState>
        {cells.error && cells.data ? <p role="status" className="text-caption text-warning">The displayed map sample could not refresh; recommendations are paused. <button type="button" className="min-h-11 text-accent underline" onClick={() => { void cells.mutate(); }}>Retry sample</button></p> : null}
        {forms.error ? <p className="text-micro text-text-muted">Recent form is unavailable. <button className="min-h-11 text-accent underline" onClick={() => { void forms.mutate(); }}>Retry form</button></p> : null}
        <p className="text-micro text-text-dim">{community.data?.computedAt ? `Community ranked 1v1 snapshot ${new Date(community.data.computedAt).toLocaleDateString()}, ${community.data.era === "after" ? "12" : "8"} starting workers. Your filters and sample window may differ.` : "Community snapshot unavailable."}{!/^[PTZ]$/.test(mine) ? " Choose your race in the filter bar for individual-matchup community comparisons." : " Community comparisons use the selected race's side; unpublished cells stay unavailable."}{community.error ? <> <button type="button" className="min-h-11 text-accent underline" onClick={() => { void community.mutate(); }}>Retry community</button></> : null}</p>
        {suggested.length < count && pool.fresh && cells.data && !cells.error && !cells.isPreviousData ? <p className="text-caption text-text-muted">{shortfallNote(suggested.length, eligible, matchup, averageLabel)}</p> : null}
        <CopyVetoes key={`${suggested.join("|")}:${matchup}`} names={suggested} matchup={matchup} />
      </div>}
    </QueryState>
  </Card>;
}
