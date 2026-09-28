import { cellVerdict } from "@/components/guides/guideUi";
import type { GuideCell } from "@/lib/guides/types";

/**
 * Tiny server-rendered interval glyph for table rows: a 0–100% track
 * with a 50% tick, the 95% confidence interval as a bar and the win rate
 * as a dot. Decorative (the row prints the same numbers as text), so it
 * is aria-hidden and needs no client JS.
 */
const WIDTH = 96;
const HEIGHT = 14;
const MID_Y = HEIGHT / 2;
const DOT_RADIUS = 3;
const TICK_HALF = 5;
const PERCENT_SCALE = 100;
const COIN_FLIP_PCT = 50;

function toPct(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * PERCENT_SCALE).toFixed(2)}%`;
}

const VERDICT_FILL = {
  win: "fill-success stroke-success",
  loss: "fill-danger stroke-danger",
  even: "fill-accent-cyan stroke-accent-cyan",
} as const;

export function CiWhisker({ cell }: { cell: Pick<GuideCell, "winRate" | "ci"> }) {
  const tone = VERDICT_FILL[cellVerdict(cell)];
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      aria-hidden="true"
      focusable="false"
      className="inline-block shrink-0 align-middle"
      data-testid="ci-whisker"
    >
      <line x1="0" x2="100%" y1={MID_Y} y2={MID_Y} className="stroke-border" strokeWidth={2} />
      <line
        x1={`${COIN_FLIP_PCT}%`}
        x2={`${COIN_FLIP_PCT}%`}
        y1={MID_Y - TICK_HALF}
        y2={MID_Y + TICK_HALF}
        className="stroke-text-dim"
        strokeWidth={1}
      />
      <line
        x1={toPct(cell.ci.low)}
        x2={toPct(cell.ci.high)}
        y1={MID_Y}
        y2={MID_Y}
        className={tone}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <circle cx={toPct(cell.winRate)} cy={MID_Y} r={DOT_RADIUS} className="fill-text stroke-bg" strokeWidth={1} />
    </svg>
  );
}
