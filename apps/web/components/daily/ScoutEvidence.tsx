import { useId, useState } from "react";
import { SCOUT_BUILDINGS, SCOUT_END, type ScoutPuzzle } from "@/lib/daily/scout";

function clock(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const whole = Math.floor(milliseconds / 1000);
  const fraction = String(milliseconds % 1000).padStart(3, "0").replace(/0+$/, "");
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0") + (fraction ? "." + fraction : "");
}

function ScoutTimeline({ visible, bounds, active, select }: {
  visible: ScoutPuzzle["buildings"]; bounds: string; active: number | null; select: (index: number) => void;
}) {
  return (
    <details open className="rounded-lg border border-line px-3 pb-3">
      <summary className="min-h-11 cursor-pointer rounded py-2.5 font-semibold text-text focus-visible:ring-2 focus-visible:ring-accent">
        Building timeline ({visible.length})
      </summary>
      {visible.length ? <ol className="max-h-72 list-decimal space-y-1 overflow-y-auto p-1 pl-6 text-caption text-text">
        {visible.map(([name, time, x, y], i) => <li key={i} className="pr-1">
          <button type="button" aria-pressed={active === i}
            className="min-h-11 w-full rounded px-2 py-1 text-left hover:bg-bg-subtle focus-visible:ring-2 focus-visible:ring-accent aria-pressed:bg-bg-subtle"
            onFocus={() => select(i)} onClick={() => select(i)}>
            <span className="mr-2 tabular-nums text-text-muted">{clock(time)}</span>{" "}{SCOUT_BUILDINGS[name]}
            <span className="block text-text-muted">{x} from left · {y} from bottom</span>
          </button>
        </li>)}
      </ol> : <p className="text-caption text-text-muted">No buildings at this time.</p>}
      <p className="mt-2 text-caption text-text-muted">Select a building to bring its marker to the front.</p>
      <p className="sr-only">{bounds}</p>
    </details>
  );
}

function markerOrder(count: number, active: number | null): number[] {
  const indices = Array.from({ length: count }, (_, index) => index);
  if (active === null) return indices;
  return [...indices.filter(index => index !== active), active];
}

function ScoutMarker({ x, y, radius, number, active }: {
  x: number; y: number; radius: number; number: number; active: boolean;
}) {
  return <g data-marker={number} transform={`translate(${x} ${y})`}>
    <circle r={radius} fill="currentColor" className={active ? "text-accent" : "text-text"} />
    <text y={radius * 0.35} textAnchor="middle" fontSize={radius * 1.07} fontWeight="bold" fill="currentColor"
      className={active ? "text-white" : "text-bg-surface"}>{number}</text>
  </g>;
}

function sliderStops(buildings: ScoutPuzzle["buildings"]): number[] {
  return Array.from(new Set([
    ...Array.from({ length: SCOUT_END + 1 }, (_, i) => i),
    ...buildings.map(([, appeared]) => appeared),
  ])).sort((a, b) => a - b);
}

export function ScoutEvidence({ puzzle }: { puzzle: ScoutPuzzle }) {
  const [time, setTime] = useState(SCOUT_END);
  const [selected, select] = useState<number | null>(null);
  const sliderId = useId();
  const gridId = useId();
  const stops = sliderStops(puzzle.buildings);
  const visible = puzzle.buildings.filter(([, appeared]) => appeared <= time);
  const active = selected !== null && selected < visible.length ? selected : null;
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
            {markerOrder(visible.length, active).map(i => {
              const [, , x, y] = visible[i];
              return <ScoutMarker key={i} number={i + 1} x={x} y={height - y} radius={radius} active={active === i} />;
            })}
          </g>
        </svg>
        <label htmlFor={sliderId} className="flex justify-between gap-2 text-body font-semibold text-text">
          Game time <span aria-hidden="true" className="tabular-nums">{clock(time)}</span>
        </label>
        <input id={sliderId} className="min-h-11 w-full cursor-pointer accent-accent focus-visible:ring-2 focus-visible:ring-accent"
          type="range" min={0} max={stops.length - 1} value={stops.indexOf(time)} aria-valuetext={clock(time)}
          onChange={event => setTime(stops[Number(event.currentTarget.value)])} />
      </div>
      <ScoutTimeline visible={visible} active={active} select={select} bounds={`The grid is ${width} units wide and ${height} units tall.`} />
    </div>
  );
}
