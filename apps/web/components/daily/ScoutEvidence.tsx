import { useId, useState } from "react";
import { SCOUT_BUILDINGS, SCOUT_END, type ScoutPuzzle } from "@/lib/daily/scout";

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

function ScoutTimeline({ visible, bounds }: { visible: ScoutPuzzle["buildings"]; bounds: string }) {
  return (
    <details open className="rounded-lg border border-line px-3 pb-3">
      <summary className="min-h-11 cursor-pointer rounded py-2.5 font-semibold text-text focus-visible:ring-2 focus-visible:ring-accent">
        Building timeline ({visible.length})
      </summary>
      {visible.length ? <ol className="list-decimal space-y-1 pl-6 text-caption text-text">
        {visible.map(([name, time, x, y], i) => <li key={i} className="pl-1">
          <span className="mr-2 tabular-nums text-text-muted">{clock(time)}</span>{SCOUT_BUILDINGS[name]}
          <span className="sr-only">{` at ${x} from the left and ${y} from the bottom`}</span>
        </li>)}
      </ol> : <p className="text-caption text-text-muted">No buildings at this time.</p>}
      <p className="mt-2 text-caption text-text-muted">Numbers match the markers on the map.</p>
      <p className="sr-only">{bounds}</p>
    </details>
  );
}

export function ScoutEvidence({ puzzle }: { puzzle: ScoutPuzzle }) {
  const [time, setTime] = useState(SCOUT_END);
  const sliderId = useId();
  const gridId = useId();
  const visible = puzzle.buildings.filter(([, appeared]) => appeared <= time);
  const { width, height } = puzzle;
  const radius = Math.max(2, Math.max(width, height) / 20);
  const margin = radius + 2;
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <svg aria-hidden="true" viewBox={`0 0 ${width + margin * 2} ${height + margin * 2}`}
          className="h-56 w-full rounded-lg border border-line bg-bg-subtle sm:h-64">
          <defs>
            <pattern id={gridId} width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M 8 0 H 0 V 8" fill="none" stroke="currentColor" strokeWidth=".2" />
            </pattern>
          </defs>
          <g transform={`translate(${margin} ${margin})`}>
            <rect width={width} height={height} fill={`url(#${gridId})`} className="text-text-muted opacity-40" />
            {visible.map(([, , x, y], i) => <g key={i} transform={`translate(${x} ${height - y})`}>
              <circle r={radius} fill="currentColor" className="text-text" />
              <text y={radius * 0.35} textAnchor="middle" fontSize={radius * 1.07} fontWeight="bold" fill="currentColor"
                className="text-bg-surface">{i + 1}</text>
            </g>)}
          </g>
        </svg>
        <label htmlFor={sliderId} className="flex justify-between gap-2 text-body font-semibold text-text">
          Game time <span aria-hidden="true" className="tabular-nums">{clock(time)}</span>
        </label>
        <input id={sliderId} className="min-h-11 w-full cursor-pointer accent-accent focus-visible:ring-2 focus-visible:ring-accent"
          type="range" min={0} max={SCOUT_END} value={time} aria-valuetext={clock(time)}
          onChange={event => setTime(Number(event.currentTarget.value))} />
      </div>
      <ScoutTimeline visible={visible} bounds={`The grid is ${width} units wide and ${height} units tall.`} />
    </div>
  );
}
