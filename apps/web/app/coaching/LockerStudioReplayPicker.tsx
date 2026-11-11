"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useApi } from "@/lib/clientApi";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import { filterStudioReplays, replayDay, studioReplays, studioReplayTitle, type StudioReplay } from "./lockerStudioReplays";

type Source = "mine" | "student";
type Props = { studentName: string; studentUserId?: string; onPick: (replay: StudioReplay) => void; onCancel: () => void };
const PAGE_LIMIT = 120;
const MAX_OWNER_ROWS = 1000;

export function LockerStudioReplayPicker({ studentName, studentUserId, onPick, onCancel }: Props) {
  const [source, setSource] = useState<Source | null>(null);
  return <section aria-label="Linked replay picker" className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2" aria-label="Replay source">
      <Button size="sm" variant="secondary" aria-pressed={source === "mine"} onClick={() => setSource("mine")}>My replays</Button>
      {studentUserId ? <Button size="sm" variant="secondary" aria-pressed={source === "student"} onClick={() => setSource("student")}>{studentName}’s replays</Button> : null}
      <Button size="sm" variant="ghost" onClick={onCancel}>Close replay picker</Button>
    </div>
    {source ? <ReplayResults key={source} source={source} studentUserId={studentUserId} onPick={onPick} /> :
      <p className="text-caption text-text-muted">Select your own replay or a student replay they’ve shared with you.</p>}
  </section>;
}

function ReplayResults({ source, studentUserId, onPick }: { source: Source; studentUserId?: string; onPick: Props["onPick"] }) {
  const [before, setBefore] = useState("");
  const [ownerRows, setOwnerRows] = useState<StudioReplay[]>([]);
  const [search, setSearch] = useState("");
  const [matchup, setMatchup] = useState("");
  const [period, setPeriod] = useState("season");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const seasons = useSeasons();
  const current = rollUpSeasons(seasons.data?.items).find(season => season.isCurrent);
  const path = source === "mine" ? `/v1/games?limit=${PAGE_LIMIT}${before ? `&before=${encodeURIComponent(before)}` : ""}`
    : studentUserId ? `/v1/coaching/students/${encodeURIComponent(studentUserId)}/games` : null;
  const games = useApi<{ games?: unknown; items?: unknown; nextBefore?: string | null }>(path, { revalidateOnFocus: false });
  useEffect(() => {
    if (source !== "mine" || !games.data) return;
    const page = studioReplays(games.data.items, "mine");
    setOwnerRows(previous => {
      if (!before) return page;
      const unique = new Map(previous.map(row => [row.key, row]));
      for (const row of page) unique.set(row.key, row);
      return [...unique.values()].slice(0, MAX_OWNER_ROWS);
    });
  }, [before, games.data, source]);
  const available = source === "mine" ? ownerRows : studioReplays(games.data?.games, "student");
  const since = period === "custom" ? from : period === "season" ? replayDay(current?.start) : "";
  const until = period === "custom" ? to : "";
  const invalidRange = Boolean(from && to && from > to && period === "custom");
  const matches = invalidRange ? [] : filterStudioReplays(available, { search, matchup, since, until });
  const options = [...new Set(available.map(row => row.matchup).filter(Boolean))].sort();
  const nextBefore = games.data?.nextBefore;

  return <div className="space-y-3 rounded-lg border border-border p-3">
    <div className="grid min-w-0 gap-2 sm:grid-cols-3">
      <Field label={source === "mine" ? "Search map, opponent or build" : "Search map or build"}><Input value={search} maxLength={120} onChange={event => setSearch(event.target.value)} /></Field>
      <Field label="Matchup"><Select value={matchup} onChange={event => setMatchup(event.target.value)}>
        <option value="">All matchups</option>{options.map(value => <option key={value} value={value}>{value}</option>)}
      </Select></Field>
      <Field label="Date range"><Select value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="season">Current season</option><option value="all">All available dates</option><option value="custom">Custom dates</option>
      </Select></Field>
    </div>
    {period === "custom" ? <div className="grid gap-2 sm:grid-cols-2">
      <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={event => setFrom(event.target.value)} /></Field>
      <Field label="Through"><Input type="date" value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></Field>
    </div> : null}
    {period === "season" && !since ? <p className="text-caption text-text-muted">Season dates are unavailable. Showing available dates.</p> : null}
    {invalidRange ? <p role="alert" className="text-caption text-danger">Choose an end date on or after the start date.</p> : null}
    {games.error ? <div className="flex flex-wrap items-center gap-2"><p role="status" className="text-caption text-text-muted">
      {source === "student" ? "Student replays are unavailable. The student needs to share their practice data with you." : "Your replays could not load."}
    </p><Button size="sm" variant="secondary" onClick={() => void games.mutate()}>Retry</Button></div> : null}
    {games.isLoading ? <p role="status" className="text-caption text-text-muted">Loading replays…</p> : null}
    {!games.error && !games.isLoading && !invalidRange && !matches.length ? <p className="text-caption text-text-muted">No replays match these filters.</p> : null}
    {matches.length ? <ul className="max-h-72 space-y-2 overflow-y-auto" aria-label="Matching replays">
      {matches.slice(0, 30).map(row => <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
        <div className="min-w-0"><p className="break-words text-caption font-semibold">{studioReplayTitle(row)}</p>
          {row.build || row.opponent ? <p className="break-words text-caption text-text-muted">{[row.build, row.opponent && `vs ${row.opponent}`].filter(Boolean).join(" · ")}</p> : null}</div>
        <Button size="sm" variant="secondary" aria-label={`Select ${studioReplayTitle(row)}`} onClick={() => onPick(row)}>Select</Button>
      </li>)}
    </ul> : null}
    {matches.length > 30 ? <p className="text-caption text-text-muted">Showing the first 30 matches. Narrow the filters to find another game.</p> : null}
    {source === "mine" && typeof nextBefore === "string" && nextBefore !== before && ownerRows.length < MAX_OWNER_ROWS ?
      <Button size="sm" variant="secondary" disabled={games.isLoading} onClick={() => setBefore(nextBefore)}>Load older replays</Button> : null}
  </div>;
}
