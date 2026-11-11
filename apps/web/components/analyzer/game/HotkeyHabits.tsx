"use client";

import { useState } from "react";
import { formatGameClock } from "@/lib/macro";
import type { ReplayMechanics } from "@/components/analyzer/macro/MacroBreakdownPanel.types";

const rate = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);

export function HotkeyHabits({ data }: { data?: ReplayMechanics }) {
  const [phase, setPhase] = useState(-1);
  if (!data) return <p className="text-caption text-text-muted">Update the desktop app and re-analyze this game to see its control-group and camera habits.</p>;
  const view = data.phases[phase] ?? data;
  const groups = new Map(view.groups?.map(row => [row.slot, row]));
  const camera = new Map(view.camera?.map(row => [row.slot, row]));
  const quietGroup = data.phases.length === 3
    ? data.groups?.find(row => row.recalls >= 3 && !data.phases[2].groups?.some(group => group.slot === row.slot && group.recalls))
    : undefined;
  return <div className="space-y-3">
    <p className="text-caption text-text-muted">Logical actions recorded in the replay. Camera returns are inferred from moves to a uniquely saved location.</p>
    <label className="flex flex-wrap items-center gap-2 text-caption">Game phase
      <select value={phase} onChange={event => setPhase(Number(event.target.value))} className="min-h-11 rounded-md border border-border bg-bg-surface px-2">
        <option value={-1}>Whole game</option>
        {data.phases.map((row, index) => <option key={row.startSec} value={index}>{formatGameClock(row.startSec)}–{formatGameClock(row.endSec)}</option>)}
      </select>
    </label>
    {view.groups ? <div><h4 className="text-caption font-semibold">Control groups</h4><ul className="mt-1 grid grid-cols-5 gap-1">
      {Array.from({ length: 10 }, (_, slot) => {
        const row = groups.get(slot), intensity = row?.recallsPerMin ?? 0;
        const color = intensity >= 8 ? "bg-accent/25" : intensity >= 3 ? "bg-accent/15" : intensity > 0 ? "bg-accent/5" : "text-text-muted";
        return <li key={slot} className={`rounded border border-border px-1 py-2 text-center text-micro ${color}`}>
          <strong className="block">{slot}</strong>
          <span>{row ? `${rate(intensity)}/min` : "—"}</span>
          {row ? <span className="block text-text-muted">{row.sets} sets · {row.recalls} recalls</span> : <span className="sr-only">Unused</span>}
        </li>;
      })}
    </ul></div> : <p className="text-caption text-text-muted">Control-group activity unavailable.</p>}
    {view.camera ? <div><h4 className="text-caption font-semibold">Camera slots</h4><ul className="mt-1 grid grid-cols-4 gap-1">
      {Array.from({ length: 8 }, (_, slot) => {
        const row = camera.get(slot);
        return <li key={slot} className="rounded border border-border px-1 py-2 text-center text-micro">
          <strong className="block">{slot + 1}</strong>
          <span>{row ? `${row.saves} saves · ${rate(row.returnsPerMin)}/min` : "Unused"}</span>
        </li>;
      })}
    </ul></div> : <p className="text-caption text-text-muted">Saved-camera activity unavailable.</p>}
    <dl className="grid grid-cols-2 gap-2 text-caption">
      {view.screenChangesPerMin != null ? <div><dt>Screen changes per minute</dt><dd>{rate(view.screenChangesPerMin)}</dd></div> : null}
      {view.selectionChangesPerMin != null ? <div><dt>Selection changes per minute</dt><dd>{rate(view.selectionChangesPerMin)}</dd></div> : null}
      {view.queuedCommandShare != null ? <div><dt>Queued commands</dt><dd>{rate(view.queuedCommandShare * 100)}%</dd></div> : null}
    </dl>
    {data.camera?.length === 0 ? <p className="text-caption text-text-muted">No camera locations saved.</p> : null}
    {quietGroup ? <p className="text-caption text-text-muted">Group {quietGroup.slot} was never recalled after 5:00.</p> : null}
  </div>;
}
