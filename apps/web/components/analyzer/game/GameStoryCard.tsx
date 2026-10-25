"use client";

import { useEffect, useMemo } from "react";
import { Card } from "@/components/ui/Card";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { gameStory, type GameStoryInput, type StoryLead } from "@/lib/gameStory";
import { formatGameClock } from "@/lib/macro";
import { resultLabel } from "./types";
import { FightLedger } from "./FightLedger";

export type GameStoryCardProps = { input: GameStoryInput; onSeek: (time: number) => void; onAvailabilityChange?: (available: boolean) => void };
const seekClass = "inline-flex min-h-11 items-center rounded-full border border-border bg-bg-elevated px-3 py-2 text-left text-micro text-text-muted hover:border-accent hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export function GameStoryCard({ input, onSeek, onAvailabilityChange }: GameStoryCardProps) {
  const story = useMemo(() => gameStory(input), [input]);
  useEffect(() => onAvailabilityChange?.(story.meaningful), [story.meaningful, onAvailabilityChange]);
  if (!story.meaningful) return null;
  return <Card title="Game story" headingLevel={2} right={<LazyHelpLink slug="game-page" anchor="game-story">Help</LazyHelpLink>} className="min-w-0" data-testid="game-story-card">
    <div className="space-y-5">
      {story.recap.length ? <div className="space-y-2 text-caption text-text-muted">{story.recap.map(sentence => <p key={sentence}>{sentence}</p>)}</div> : null}
      {story.leadSeries.length ? <LeadStrip series={story.leadSeries} /> : null}
      {story.chips.length ? <div className="flex flex-wrap gap-2" aria-label="Game highlights">{story.chips.map(chip => <button type="button" key={chip.id} onClick={() => onSeek(chip.time)} className={seekClass} aria-label={`${chip.label}. Watch replay at ${formatGameClock(chip.time)}`}>{chip.label}</button>)}</div> : null}
      {story.turningPoints.length ? <section className="space-y-2"><h3 className="text-caption font-semibold">Largest 30-second swings</h3><p className="text-micro text-text-muted">These describe changes in the sampled lead, not what caused them.</p><div className="flex flex-wrap gap-2">{story.turningPoints.map(point => <button type="button" key={`${point.start}:${point.time}`} onClick={() => onSeek(point.time)} className={seekClass}>{point.label}</button>)}</div></section> : null}
      {story.topLeak ? <section className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3"><h3 className="text-caption font-semibold">{resultLabel(input.result) === "Win" ? "Still cost you" : "Macro cost"}</h3><p className="text-caption text-text-muted"><strong className="text-text">{story.topLeak.name}</strong> · {story.topLeak.detail}</p>{story.topLeak.time !== null ? <button type="button" className={seekClass} onClick={() => onSeek(story.topLeak!.time!)}>Watch leak at {formatGameClock(story.topLeak.time)}</button> : <p className="text-micro text-text-dim">Whole-game estimate; no individual timestamp was recorded.</p>}</section> : null}
      <FightLedger fights={story.fights} onSeek={onSeek} />
    </div>
  </Card>;
}

function LeadStrip({ series }: { series: readonly StoryLead[] }) {
  const bands = useMemo(() => leadBands(series), [series]);
  const first = formatGameClock(series[0].time), last = formatGameClock(series.at(-1)!.time);
  if (!bands.length) return <p className="text-micro text-text-muted">One paired sample at {first}; continuous lead coverage was not measured.</p>;
  return <figure className="space-y-2">
    <div role="img" aria-label={`Relative lead from ${first} to ${last}. Above the center favors you; below favors your opponent. Dashed bands are unmeasured.`} className="relative flex h-20 items-stretch overflow-hidden rounded-md border border-border bg-bg-elevated" data-testid="game-story-lead-strip">
      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-border-strong" />
      {bands.map(band => <span key={`${band.start}:${band.end}`} data-start={band.start} data-end={band.end} data-lead-state={band.value === null ? "unknown" : "known"} className="relative min-w-0 flex-1" title={`${formatGameClock(band.start)}–${formatGameClock(band.end)} · ${band.value === null ? "unmeasured" : band.value > 0 ? "lead toward you" : band.value < 0 ? "lead toward opponent" : "even lead"}`} aria-hidden>
        {band.value === null ? <span className="absolute inset-x-0 top-[40%] h-[20%] border border-dashed border-text-dim/50" /> : <span className={`absolute inset-x-0 ${band.value >= 0 ? "bottom-1/2 bg-success/75" : "top-1/2 bg-danger/75"}`} style={{ height: `${Math.min(1, Math.abs(band.value)) * 48}%` }} />}
      </span>)}
    </div>
    <figcaption className="space-y-1 text-micro text-text-muted"><div className="flex justify-between font-mono tabular-nums"><span>{first}</span><span>{last}</span></div><p><span className="font-semibold text-success">Above: you</span> · <span className="font-semibold text-danger">Below: opponent</span>. Army value, workers and income have equal weight in this relative index. It is not a win probability. Bands follow elapsed time; unmeasured values and gaps over 30 seconds stay unknown.</p></figcaption>
  </figure>;
}

/** Time bins preserve a long telemetry gap's actual width. Never interpolate
 * across an unknown observation or >30s interval just to fill a colored band. */
function leadBands(series: readonly StoryLead[]) {
  const first = series[0]?.time ?? 0, duration = (series.at(-1)?.time ?? first) - first;
  if (!(duration > 0)) return [];
  const count = Math.min(120, Math.max(1, Math.ceil(duration / 10)));
  let index = 0;
  return Array.from({ length: count }, (_, i) => {
    const start = first + duration * i / count, end = first + duration * (i + 1) / count;
    let cursor = start, area = 0, known = true;
    while (cursor < end) {
      while (index + 1 < series.length && series[index + 1].time <= cursor) index++;
      const a = series[index], b = series[index + 1];
      if (!a || !b || b.time - a.time > 30 || a.combinedLead === null || b.combinedLead === null) { known = false; break; }
      const next = Math.min(end, b.time);
      const at = (time: number) => a.combinedLead! + (b.combinedLead! - a.combinedLead!) * (time - a.time) / (b.time - a.time);
      area += (at(cursor) + at(next)) / 2 * (next - cursor);
      cursor = next;
    }
    return { start, end, value: known ? area / (end - start) : null };
  });
}
