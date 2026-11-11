"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { LengthRecord, MapRecordRow } from "@/lib/instant/report";
import { gamesLabel, ReportCard, WinLoss, WinrateBar, WinrateText } from "./ReportBits";

function RecordSplitRow({ label, games, wins, losses }: { label: string; games: number; wins: number; losses: number }) {
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="break-words font-semibold text-text">{label}</span>
        <span className="flex flex-wrap items-baseline gap-3 text-caption">
          <span className="text-text-muted">{gamesLabel(games)}</span>
          <WinLoss wins={wins} losses={losses} />
          <WinrateText wins={wins} losses={losses} />
        </span>
      </div>
      <WinrateBar wins={wins} losses={losses} />
    </li>
  );
}

const VISIBLE_MAPS = 8;

export function RecordByMapCard({ rows }: { rows: MapRecordRow[] | null }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!rows?.length) return null;
  const visible = expanded ? rows : rows.slice(0, VISIBLE_MAPS);
  return (
    <ReportCard title="Record by map" testId="report-maps">
      <ul id={listId} className="space-y-3">
        {visible.map((row) => <RecordSplitRow key={String(row.known) + row.map} label={row.map} games={row.games} wins={row.wins} losses={row.losses} />)}
      </ul>
      {rows.length > VISIBLE_MAPS ? <Button variant="ghost" size="sm" className="mt-3 min-h-11" aria-controls={listId}
        aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show fewer maps" : "Show all " + rows.length + " maps"}
      </Button> : null}
    </ReportCard>
  );
}

export function RecordByLengthCard({ record }: { record: LengthRecord | null }) {
  if (!record) return null;
  return (
    <ReportCard title="By game length" testId="report-length">
      {record.buckets.length ? <ul className="space-y-3">
        {record.buckets.map((row) => <RecordSplitRow key={row.key} label={row.label} games={row.games} wins={row.wins} losses={row.losses} />)}
      </ul> : null}
      {record.missing ? <p className="mt-2 text-caption text-text-muted">{gamesLabel(record.missing)} without a length</p> : null}
    </ReportCard>
  );
}
