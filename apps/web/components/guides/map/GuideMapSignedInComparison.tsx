"use client";

import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/clientApi";
import { communityMapRate, mapRecord, poolMapRows, type MapMatchupStats } from "@/lib/mapVeto";
import { Select } from "@/components/ui/Select";
import { QueryState } from "@/components/ui/QueryState";
import { WinRateCell } from "@/components/guides/WinRateCell";
import { fmtPct, fmtDeltaPp } from "@/lib/guides/format";
import type { GuideIndexMap, GuideMapPayload } from "@/lib/guides/types";
import { GUIDE_LINK_CLASS } from "../guideUi";

export function GuideMapSignedInComparison({ payload }: { payload: GuideMapPayload }) {
  const [race, setRace] = useState("");
  const query = useApi<MapMatchupStats[]>(`/v1/maps/matchups?patch_era=${payload.era}${race ? `&race=${race}` : ""}`, { revalidateOnFocus: false, keepPreviousData: false });
  const row = poolMapRows([payload.map], query.isPreviousData ? [] : query.data ?? [])[0];
  const community: GuideIndexMap[] = payload.published ? [{ map: payload.map, slug: payload.mapSlug, games: payload.games, cells: payload.matchups }] : [];
  const focus = `/app/maps?focus=${encodeURIComponent(payload.map)}`;
  return <div className="space-y-3"><label className="block max-w-xs text-caption font-semibold text-text">Your race<Select value={race} onChange={(event) => setRace(event.target.value)}><option value="">All my races</option>{["P", "T", "Z"].map((value) => <option key={value} value={value}>{value === "P" ? "Protoss" : value === "T" ? "Terran" : "Zerg"}</option>)}</Select></label>
    <p className="text-micro text-text-muted">Your synced {payload.era === "after" ? "12" : "8"}-worker games across all time; ties are excluded from win rates. Select your race for community comparisons.</p>
    <QueryState q={query} errorTitle="Couldn't load your map record" isEmpty={() => !row.all.total} empty={<p className="text-caption text-text-muted">You have no synced games on this map in this sample yet. <Link href="/download" className={GUIDE_LINK_CLASS}>Sync your replays</Link> to compare.</p>}>
      {() => <div className="grid gap-2 sm:grid-cols-3">{["P", "T", "Z"].map((opponent) => {
        const record = row.cells[opponent] ?? mapRecord(), rate = communityMapRate(community, payload.map, race, opponent);
        return <div key={opponent} className="space-y-1 rounded-lg border border-border p-3"><h3 className="text-caption font-semibold text-text">vs {opponent}</h3><p className="text-caption tabular-nums">{record.wins}W · {record.losses}L · n={record.decided} decided</p>{record.winRate !== null && record.ci ? <WinRateCell winRate={record.winRate} ci={record.ci} /> : <p className="text-micro text-text-dim">No decided games</p>}{rate !== null ? <p className="text-micro text-text-muted">Community {fmtPct(rate)}{record.winRate !== null ? ` (${fmtDeltaPp(record.winRate - rate)})` : ""}</p> : null}</div>;
      })}</div>}
    </QueryState>
    <Link href={focus} className={`${GUIDE_LINK_CLASS} inline-flex min-h-11 items-center`}>Open your maps and veto planner</Link>
  </div>;
}
