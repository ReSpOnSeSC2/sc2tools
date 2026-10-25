import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import { formatGameClock } from "@/lib/macro";

const WIDTH = 400, HEIGHT = 190, PAD = 22;
const known = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function samples(rows: readonly StatsEvent[] | undefined, from: number, until: number) {
  return (rows ?? []).filter((row) => known(row.time) && row.time >= from && row.time <= until).slice(0, 500).sort((a, b) => a.time - b.time);
}

function segments(rows: readonly StatsEvent[], x: (time: number) => number, y: (value: number) => number) {
  const groups: { x: number; y: number }[][] = []; let group: { x: number; y: number }[] = [];
  let previous = -Infinity;
  for (const row of rows) {
    if (group.length && row.time - previous > 30) { groups.push(group); group = []; }
    if (!known(row.army_value)) { if (group.length) groups.push(group); group = []; }
    else group.push({ x: x(row.time), y: y(row.army_value) });
    previous = row.time;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function ArmySnapshot({ time, duration, mine, opponent }: { time: number; duration: number | null; mine?: readonly StatsEvent[]; opponent?: readonly StatsEvent[] }) {
  const from = Math.max(0, time - 60), until = Math.max(from + 1, Math.min(duration ?? time + 60, time + 60));
  const me = samples(mine, from, until), opp = samples(opponent, from, until);
  const values = [...me, ...opp].flatMap((row) => known(row.army_value) ? [row.army_value] : []);
  if (!values.length) return <div className="flex aspect-[16/10] max-h-64 items-center justify-center bg-bg-elevated p-5 text-center text-caption text-text-muted">No army-value samples near this moment.</div>;
  const maximum = Math.max(1, ...values), x = (t: number) => PAD + (t - from) / (until - from) * (WIDTH - 2 * PAD), y = (v: number) => HEIGHT - PAD - v / maximum * (HEIGHT - 2 * PAD);
  return <svg role="img" aria-label={`Recorded army-value samples around ${formatGameClock(time)}. You in cyan; opponent in red.`} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="aspect-[16/10] max-h-64 w-full bg-bg-elevated">
    <line x1={PAD} x2={WIDTH - PAD} y1={HEIGHT - PAD} y2={HEIGHT - PAD} stroke="rgb(var(--border-strong))" />
    <line x1={x(time)} x2={x(time)} y1={PAD} y2={HEIGHT - PAD} stroke="rgb(var(--text-dim))" strokeDasharray="4 4" />
    {[{ rows: me, color: "rgb(var(--player-you))" }, { rows: opp, color: "rgb(var(--player-opp))" }].map((side) => segments(side.rows, x, y).map((group, index) => group.length === 1 ? <circle key={`${side.color}:${index}`} cx={group[0].x} cy={group[0].y} r={3} fill={side.color} /> : <path key={`${side.color}:${index}`} d={group.map((point, i) => `${i ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} fill="none" stroke={side.color} strokeWidth={2.5} strokeLinecap="round" />))}
    <text x={PAD} y={14} fill="rgb(var(--text-muted))" fontSize={10}>{Math.round(maximum).toLocaleString()} army value</text>
    <text x={PAD} y={HEIGHT - 6} fill="rgb(var(--text-dim))" fontSize={10}>{formatGameClock(from)}</text><text x={WIDTH - PAD} y={HEIGHT - 6} textAnchor="end" fill="rgb(var(--text-dim))" fontSize={10}>{formatGameClock(until)}</text>
  </svg>;
}
