"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Search, Users, X } from "lucide-react";
import { useGlobalTrendsApi as useApi } from "@/lib/globalTrendsApi";
import { filtersToQuery } from "@/lib/filterContext";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { INPUT } from "./GlobalGameFilters";
import { ALL_PLAYERS, RACES, isPlayerSelected, mmrRangeError, populationQuery, selectionLabel, selectPlayers,
  type Population, type TrendPlayer, type TrendPlayersResponse } from "./globalTrendsState";

const PAGE_SIZE = 50;
const CHECKBOX = "h-4 w-4 shrink-0 cursor-pointer accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

function dateLabel(value: string | null) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : "Date unavailable";
}

export function GlobalPlayerPicker({ population, onApply, revision }: {
  population: Population; onApply: (next: Population) => void; revision: number;
}) {
  const [draft, setDraft] = useState(population);
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState("mmr");
  const [order, setOrder] = useState("desc");
  const [names, setNames] = useState<Record<string, string>>({});
  const id = useId();
  useEffect(() => setDraft(population), [population]);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchText.trim()); setPage(0); }, 250);
    return () => clearTimeout(timer);
  }, [searchText]);
  const params = useMemo(() => ({ ...populationQuery(population), refresh_after: revision || undefined, page, limit: PAGE_SIZE, search, sort, order }), [population, revision, page, search, sort, order]);
  const players = useApi<TrendPlayersResponse>(`/v1/admin/global-trends/players${filtersToQuery(params)}#${revision}`, { revalidateOnFocus: false });
  useEffect(() => {
    if (!players.data) return;
    setNames((old) => ({ ...old, ...Object.fromEntries(players.data!.items.map((p) => [p.playerId, p.displayName])) }));
  }, [players.data]);
  const changed = JSON.stringify(populationQuery(draft)) !== JSON.stringify(populationQuery(population));
  const rangeError = mmrRangeError(draft.mmrMin, draft.mmrMax);
  const items = players.error ? [] : players.data?.items || [];
  const set = (patch: Partial<Population>) => setDraft((old) => ({ ...old, ...patch }));
  const editPlayers = (ids: string[], selected: boolean) => setDraft((old) => selectPlayers(old, ids, selected));

  return (
    <section aria-label="Player population" className="overflow-hidden rounded-xl border-2 border-line bg-bg-surface">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Users className="h-5 w-5 text-accent" aria-hidden />Player population</h2>
            <p className="mt-1 text-caption text-text-muted">Choose whose games contribute, then apply your selection.</p>
          </div>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-caption font-medium text-accent" aria-live="polite">
            {players.data && !players.error ? `${players.data.selectedTotal.toLocaleString()} of ${(players.data.rosterTotal ?? players.data.total).toLocaleString()} players included` : selectionLabel(population)}
          </span>
        </div>
        <fieldset>
          <legend className="mb-2 text-caption font-medium text-text-muted">Include games played as</legend>
          <div className="flex flex-wrap gap-2">
            {RACES.map((race) => {
              const included = !draft.excludedRaces.includes(race.value);
              return <button key={race.value} type="button" aria-pressed={included} onClick={() => set({ excludedRaces: included ? [...draft.excludedRaces, race.value] : draft.excludedRaces.filter((r) => r !== race.value) })}
                className={`inline-flex min-h-11 items-center gap-2 rounded-lg border-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${included ? "border-accent/40 bg-accent/10 text-text" : "border-line bg-bg text-text-dim"}`}>
                <span className={`h-2 w-2 rounded-full ${included ? "bg-accent" : "bg-border"}`} aria-hidden />{race.label}
              </button>;
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-caption text-text-muted"><span>Current player MMR · minimum</span>
            <input className={INPUT} type="number" min="0" max="10000" step="1" placeholder="No minimum" value={draft.mmrMin} onChange={(e) => set({ mmrMin: e.target.value })} aria-invalid={!!rangeError} aria-describedby={rangeError ? `${id}-error` : undefined} />
          </label>
          <label className="space-y-1 text-caption text-text-muted"><span>Current player MMR · maximum</span>
            <input className={INPUT} type="number" min="0" max="10000" step="1" placeholder="No maximum" value={draft.mmrMax} onChange={(e) => set({ mmrMax: e.target.value })} aria-invalid={!!rangeError} aria-describedby={rangeError ? `${id}-error` : undefined} />
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-muted"><input type="checkbox" className={CHECKBOX} checked={draft.includeUnrated} onChange={(e) => set({ includeUnrated: e.target.checked })} />Include players without MMR</label>
        </div>
        {rangeError && <p role="alert" id={`${id}-error`} className="text-sm text-danger">{rangeError}</p>}
      </div>

      <details open className="border-t border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:px-5">Player directory <span className="ml-2 font-normal text-text-muted">{players.data ? `${players.data.total.toLocaleString()}${search ? " matching" : " total"}` : ""}</span></summary>
        <div className="space-y-3 px-4 pb-4 sm:px-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_9rem]">
            <label className="relative"><span className="sr-only">Search players</span><Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-text-dim" aria-hidden />
              <input className={`${INPUT} pl-9`} value={searchText} placeholder="Search name or account ID…" onChange={(e) => setSearchText(e.target.value)} />
            </label>
            <Select className="min-h-11" aria-label="Sort players by" value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }}>
              <option value="mmr">Current MMR</option><option value="name">Player name</option><option value="gameCount">Games</option><option value="lastSeen">Last played</option>
            </Select>
            <Select className="min-h-11" aria-label="Player sort direction" value={order} onChange={(e) => { setOrder(e.target.value); setPage(0); }}><option value="desc">Descending</option><option value="asc">Ascending</option></Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => set({ selection: "all", playerIds: [] })}>Select all players</Button>
            <Button variant="ghost" size="sm" onClick={() => set({ selection: "include", playerIds: [] })}>Clear selection</Button>
            <span className="hidden h-5 border-l border-border sm:block" aria-hidden />
            <Button variant="ghost" size="sm" disabled={!items.length || players.isLoading} onClick={() => editPlayers(items.map((p) => p.playerId), true)}>Include page</Button>
            <Button variant="ghost" size="sm" disabled={!items.length || players.isLoading} onClick={() => editPlayers(items.map((p) => p.playerId), false)}>Exclude page</Button>
          </div>
          <p className="text-caption text-text-dim">Search only changes the directory. Checkboxes combine with the race and MMR filters above. Row status reflects the applied filters.</p>
          {players.error ? (
            <div role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-4"><p className="text-sm text-danger">Could not load players. {players.error.message}</p><Button className="mt-2" variant="secondary" size="sm" onClick={() => { void players.mutate(); }}>Retry player directory</Button></div>
          ) : players.isLoading ? (
            <div role="status" className="space-y-2 py-4"><span className="sr-only">Loading players</span>{[1, 2, 3, 4].map((i) => <div key={i} className="h-10 animate-pulse rounded bg-bg-elevated" />)}</div>
          ) : items.length ? (
            <div className="max-h-[360px] overflow-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Players and current MMR">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-bg-elevated text-xs text-text-muted"><tr>
                  <th scope="col" className="p-3"><span className="sr-only">Include</span></th><th scope="col" className="p-3 font-medium">Player</th><th scope="col" className="p-3 font-medium">Latest race</th><th scope="col" className="p-3 text-right font-medium">Current MMR</th><th scope="col" className="p-3 text-right font-medium">Games</th><th scope="col" className="p-3"><span className="sr-only">Focus player</span></th>
                </tr></thead>
                <tbody className="divide-y divide-border">{items.map((player) => <PlayerRow key={player.playerId} player={player} selected={isPlayerSelected(draft, player.playerId)} onSelect={(selected) => editPlayers([player.playerId], selected)} onOnly={() => set({ selection: "include", playerIds: [player.playerId] })} />)}</tbody>
              </table>
            </div>
          ) : <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">{search ? "No players match this search. Try a name or account ID." : "No player histories have been uploaded yet."}</p>}
          {players.data && !players.error && <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-caption text-text-muted">{players.data.total ? `${(page * PAGE_SIZE + 1).toLocaleString()}–${Math.min((page + 1) * PAGE_SIZE, players.data.total).toLocaleString()} of ${players.data.total.toLocaleString()}` : "0 players"}</span>
            <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={page === 0 || players.isLoading} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={!players.data.hasMore || players.isLoading} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
          </div>}
          <p className="text-caption text-text-dim">MMR shows the latest available ladder rating, with its source and date. Each account is listed separately; older unidentified histories are grouped by uploader.</p>
          {draft.playerIds.length > 0 && <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-caption font-medium">Review {selectionLabel(draft).toLowerCase()}</summary>
            <div className="mt-3 flex max-h-40 flex-wrap gap-2 overflow-auto">{draft.playerIds.map((playerId) => <button key={playerId} type="button" className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-border bg-bg-elevated px-3 text-caption focus-visible:ring-2 focus-visible:ring-accent" onClick={() => set({ playerIds: draft.playerIds.filter((p) => p !== playerId) })} aria-label={`Remove ${names[playerId] || playerId} from ${draft.selection === "include" ? "selection" : "exclusions"}`}><span className="truncate">{names[playerId] || playerId}</span><X className="h-3 w-3 shrink-0" aria-hidden /></button>)}</div>
          </details>}
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-elevated/50 px-4 py-3 sm:px-5">
        <p className="text-caption text-text-muted" aria-live="polite">{changed ? `Unapplied changes · ${selectionLabel(draft)}` : `Player filters applied · ${selectionLabel(population)}`}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setDraft({ ...ALL_PLAYERS }); onApply({ ...ALL_PLAYERS }); }}>Reset player filters</Button>
          <Button size="sm" disabled={!changed || !!rangeError} onClick={() => onApply(draft)}>Apply player filters</Button>
        </div>
      </div>
    </section>
  );
}

function PlayerRow({ player, selected, onSelect, onOnly }: {
  player: TrendPlayer; selected: boolean; onSelect: (value: boolean) => void; onOnly: () => void;
}) {
  const race = RACES.find((r) => r.value === player.race || r.label === player.race)?.label || "Unknown";
  const source = player.mmrSource === "pulse" ? "SC2Pulse" : player.mmrSource === "replay" ? "Latest replay" : "Latest known";
  return <tr className={`transition-colors hover:bg-bg-elevated/60 ${selected ? "" : "bg-bg/40 text-text-muted"}`}>
    <td className="p-3"><label className="flex min-h-8 min-w-6 cursor-pointer items-center justify-center"><input className={CHECKBOX} type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Include ${player.displayName} (${player.playerId})`} /></label></td>
    <td className="p-3">
      <span className="block max-w-[220px] truncate font-medium" title={player.displayName}>{player.displayName}</span>
      <span className="block max-w-[220px] truncate text-xs text-text-dim" title={player.playerId}>{player.playerId}</span>
      <span className={`mt-1 block text-xs ${player.included ? "text-success" : "text-text-dim"}`}>{player.included ? "Included" : "Filtered out"}</span>
    </td>
    <td className="p-3 text-caption text-text-muted">{race}</td>
    <td className="whitespace-nowrap p-3 text-right"><span className="font-semibold tabular-nums">{player.currentMmr == null ? "Unavailable" : player.currentMmr.toLocaleString()}</span>{player.currentMmr != null && <span className="block text-xs text-text-dim">{source} · {dateLabel(player.mmrUpdatedAt)}</span>}</td>
    <td className="p-3 text-right tabular-nums">{player.gameCount.toLocaleString()}</td>
    <td className="p-2"><Button variant="ghost" size="sm" aria-label={`Only include ${player.displayName}`} onClick={onOnly}>Only</Button></td>
  </tr>;
}
