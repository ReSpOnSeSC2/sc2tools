"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useChartKit } from "@/lib/charts/theme";
import type { SessionDetailTrack, SessionMmrStep } from "@/lib/sessionHistory";
import { recordedMmr, sessionInstant, sessionRace } from "./sessionCardFormat";

/** One step path, with fresh segments after missing values; no synthetic start. */
export function sessionMmrCurve(steps: readonly SessionMmrStep[]) {
  const numeric = steps.filter(step => step.value !== null).map(step => step.value as number);
  const min = numeric.length ? Math.min(...numeric) : 0, max = numeric.length ? Math.max(...numeric) : 0;
  const first = steps[0]?.position ?? 1, last = steps.at(-1)?.position ?? first;
  const x = (position: number) => 64 + 700 * (position - first) / Math.max(1, last - first);
  const y = (value: number) => max === min ? 118 : 218 - 200 * (value - min) / (max - min);
  let path = "", connected = false;
  for (const step of steps) {
    if (step.value === null) { connected = false; continue; }
    const px = x(step.position), py = y(step.value);
    path += connected ? ` H${px} V${py}` : ` M${px} ${py} h0.01`;
    connected = true;
  }
  return { path, min, max, first, last, x, y };
}

export function SessionMmrChart({ tracks, timeZone }: { tracks: readonly SessionDetailTrack[]; timeZone: string }) {
  const [index, setIndex] = useState(0), track = tracks[index];
  if (!track) return <p className="text-caption text-text-muted">No exact-account rating tracks are available.</p>;
  return <section aria-label="Session recorded MMR" className="min-w-0 space-y-3">
    <nav aria-label="Recorded MMR accounts" className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous account track</Button><span className="text-caption">Track {index + 1} of {tracks.length}</span>
      <Button variant="secondary" disabled={index + 1 === tracks.length} onClick={() => setIndex(index + 1)}>Next account track</Button>
    </nav>
    <p className="break-all text-body font-semibold"><bdi>{track.myToonHandle}</bdi> · Queue race: {sessionRace(track.ladderRace)}</p>
    <p className="text-caption text-text-muted">Rating scope: {track.ratingScope.replace("-", " · ")} · {track.samples} valid recorded samples · {track.missingGames} missing · {track.legacySamples} legacy.</p>
    <SessionTrackView key={JSON.stringify([track.myToonHandle, track.ladderRace, track.ratingScope])} track={track} timeZone={timeZone} />
  </section>;
}

function SessionTrackView({ track, timeZone }: { track: SessionDetailTrack; timeZone: string }) {
  const [page, setPage] = useState(0), [inspected, setInspected] = useState(0);
  const kit = useChartKit(), selected = track.steps[inspected];
  const curve = useMemo(() => sessionMmrCurve(track.steps), [track.steps]);
  const comparable = comparableTrack(track);
  const rows = track.steps.slice(page * 50, page * 50 + 50);
  return <div className="space-y-3">
    {comparable && track.samples > 0 ? <><p className="flex flex-wrap justify-between gap-2 text-caption text-text-muted"><span>Recorded MMR {recordedMmr(curve.min)}–{recordedMmr(curve.max)}</span><span>Recorded game positions {curve.first}–{curve.last}</span></p><svg role="img" aria-label={`Full recorded MMR curve for ${track.myToonHandle}, ${track.samples} observed values, ${track.missingGames} gaps`} viewBox="0 0 800 260" preserveAspectRatio="none" className="h-56 w-full">
      <path d="M64 18 V218 H764" fill="none" stroke={kit.grid} /><path data-testid="recorded-mmr-curve" d={curve.path} fill="none" stroke={kit.series[0]} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <InspectedPoint selected={selected} curve={curve} color={kit.tokens.text} />
    </svg></> : <p className="text-caption text-text-muted">{comparable ? "No valid recorded MMR values in this track." : "Rating track not fully identified. Review the raw recorded observations below; no connected ladder curve or rating change is inferred."}</p>}
    {comparable ? <p className="text-caption text-text-dim">The curve covers the full bounded session for this exact track. Gaps retain missing ratings. The point table is paged separately.</p> : null}
    <label className="block text-caption font-semibold">Inspect a recorded observation<input className="block min-h-11 w-full" type="range" aria-valuetext={selected ? `Game ${selected.position}: ${recordedMmr(selected.value)}` : "No observations"} min={0} max={Math.max(0, track.steps.length - 1)} value={inspected} onChange={event => setInspected(Number(event.target.value))} /></label>
    {selected ? <p role="status" className="text-caption">Game {selected.position} · {sessionInstant(selected.date, timeZone)} · {recordedMmr(selected.value)} · {selected.source ?? "missing source"}</p> : null}
    <details open={!comparable}><summary className="min-h-11 cursor-pointer py-3 text-caption font-semibold">Recorded point table</summary>
      <p className="text-caption text-text-muted">Showing {page * 50 + 1}–{page * 50 + rows.length} of {track.steps.length} observations. Table paging leaves the full-session curve unchanged.</p>
      <div className="overflow-x-auto"><table className="w-full text-caption"><caption className="sr-only">Recorded MMR observations for the selected exact track</caption><thead><tr><th scope="col">Game position</th><th scope="col">Recorded game end</th><th scope="col">MMR</th><th scope="col">Source</th></tr></thead><tbody>{rows.map(row => <RecordedPoint key={row.position} row={row} timeZone={timeZone} />)}</tbody></table></div>
      <nav aria-label="Recorded point table pages" className="mt-3 flex flex-wrap gap-3"><Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous 50 observations</Button><Button variant="secondary" disabled={(page + 1) * 50 >= track.steps.length} onClick={() => setPage(page + 1)}>Next 50 observations</Button></nav>
    </details>
  </div>;
}

function RecordedPoint({ row, timeZone }: { row: SessionMmrStep; timeZone: string }) {
  return <tr><td className="p-2 tabular-nums">{row.position}</td><td className="p-2"><time dateTime={row.date}>{sessionInstant(row.date, timeZone)}</time></td><td className="p-2 tabular-nums">{recordedMmr(row.value)}</td><td className="p-2">{row.source ?? "Missing"}</td></tr>;
}

function comparableTrack(track: SessionDetailTrack): boolean {
  return track.comparable && track.ladderRace !== null && track.ratingScope === "ranked-1v1";
}

function InspectedPoint({ selected, curve, color }: { selected?: SessionMmrStep; curve: ReturnType<typeof sessionMmrCurve>; color: string }) {
  if (!selected || selected.value === null) return null;
  return <circle cx={curve.x(selected.position)} cy={curve.y(selected.value)} r="4" fill={color} />;
}
