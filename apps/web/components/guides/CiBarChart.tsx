"use client";

import { useCallback, useId, useRef, useState, type KeyboardEvent } from "react";
import { fmtCi, fmtCount, fmtCountNoun, fmtPct } from "@/lib/guides/format";
import type { GuideCi } from "@/lib/guides/types";

/**
 * CiBarChart — hand-rolled horizontal win-rate bars with 95% confidence
 * whiskers and an n label per row (no chart library: this island ships
 * a few kB of JS). SSR renders the full SVG + an sr-only data table, so
 * crawlers and screen readers get every number without JS.
 *
 * Interaction: each row is focusable (Tab / ↑ ↓ / Home / End) and shows
 * a tooltip on hover or focus; Escape hides it. Rows carry an aria-label
 * with the full reading, e.g. "Diamond: 56.6% win rate, likely range
 * 48.5–64.4%, 146 games".
 */

export interface CiBarDatum {
  key: string;
  label: string;
  winRate: number;
  ci: GuideCi;
  games: number;
  users?: number;
}

export interface CiBarChartProps {
  /** Accessible name of the chart (also the sr-only table caption). */
  title: string;
  data: ReadonlyArray<CiBarDatum>;
}

const ROW_HEIGHT = 22;
const BAR_HEIGHT = 12;
const BAR_Y = (ROW_HEIGHT - BAR_HEIGHT) / 2;
const MID_Y = ROW_HEIGHT / 2;
const CAP_HEIGHT = 7;
const BAR_RADIUS = 3;
const PERCENT_SCALE = 100;
const COIN_FLIP = 0.5;
const COIN_FLIP_X = "50%";

function toX(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * PERCENT_SCALE).toFixed(2)}%`;
}

function barTone(datum: CiBarDatum): string {
  if (datum.ci.low > COIN_FLIP) return "fill-success/70";
  if (datum.ci.high < COIN_FLIP) return "fill-danger/70";
  return "fill-accent-cyan/60";
}

/** Full spoken reading of one row. */
export function ciBarRowLabel(datum: CiBarDatum): string {
  const players = typeof datum.users === "number" ? `, ${fmtCountNoun(datum.users, "player")}` : "";
  return `${datum.label}: ${fmtPct(datum.winRate)} win rate, likely range ${fmtCi(datum.ci)}, ${fmtCount(datum.games)} games${players}`;
}

function RowBars({ datum }: { datum: CiBarDatum }) {
  const low = toX(datum.ci.low);
  const high = toX(datum.ci.high);
  return (
    <svg width="100%" height={ROW_HEIGHT} aria-hidden="true" focusable="false" className="block min-w-0">
      <rect x="0" y={BAR_Y} width="100%" height={BAR_HEIGHT} rx={BAR_RADIUS} className="fill-bg-elevated" />
      <rect
        x="0"
        y={BAR_Y}
        width={toX(datum.winRate)}
        height={BAR_HEIGHT}
        rx={BAR_RADIUS}
        className={barTone(datum)}
        data-testid="ci-bar"
      />
      <line x1={COIN_FLIP_X} x2={COIN_FLIP_X} y1={0} y2={ROW_HEIGHT} className="stroke-text-dim" strokeDasharray="2 3" />
      <line x1={low} x2={high} y1={MID_Y} y2={MID_Y} className="stroke-text" strokeWidth={2} />
      <line x1={low} x2={low} y1={MID_Y - CAP_HEIGHT / 2} y2={MID_Y + CAP_HEIGHT / 2} className="stroke-text" strokeWidth={2} />
      <line x1={high} x2={high} y1={MID_Y - CAP_HEIGHT / 2} y2={MID_Y + CAP_HEIGHT / 2} className="stroke-text" strokeWidth={2} />
    </svg>
  );
}

function RowTooltip({ id, datum }: { id: string; datum: CiBarDatum }) {
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute left-0 top-full z-20 mt-1 w-max max-w-full rounded-lg sm:left-1/3 sm:max-w-[16rem] border-2 border-line bg-bg-surface px-3 py-2 text-caption text-text shadow-hard"
    >
      <div className="font-semibold">{datum.label}</div>
      <div className="tabular-nums">{fmtPct(datum.winRate)} win rate</div>
      <div className="tabular-nums text-text-muted">Likely range {fmtCi(datum.ci)}</div>
      <div className="tabular-nums text-text-muted">
        {fmtCount(datum.games)} games
        {typeof datum.users === "number" ? ` · ${fmtCountNoun(datum.users, "player")}` : ""}
      </div>
    </div>
  );
}

function DataTable({ title, data }: CiBarChartProps) {
  return (
    <table className="sr-only">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Win rate</th>
          <th scope="col">Likely range (95%)</th>
          <th scope="col">Games</th>
        </tr>
      </thead>
      <tbody>
        {data.map((datum) => (
          <tr key={datum.key}>
            <th scope="row">{datum.label}</th>
            <td>{fmtPct(datum.winRate)}</td>
            <td>{fmtCi(datum.ci)}</td>
            <td>{fmtCount(datum.games)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function nextIndex(key: string, index: number, count: number): number | null {
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

interface ChartRowProps {
  datum: CiBarDatum;
  tooltipId: string;
  isActive: boolean;
  register: (node: HTMLLIElement | null) => void;
  onActivate: (key: string | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => void;
}

function ChartRow({ datum, tooltipId, isActive, register, onActivate, onKeyDown }: ChartRowProps) {
  return (
    <li
      ref={register}
      tabIndex={0}
      aria-label={ciBarRowLabel(datum)}
      aria-describedby={isActive ? tooltipId : undefined}
      onMouseEnter={() => onActivate(datum.key)}
      onMouseLeave={() => onActivate(null)}
      onFocus={() => onActivate(datum.key)}
      onBlur={() => onActivate(null)}
      onKeyDown={onKeyDown}
      className="relative grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-0.5 hover:bg-bg-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]"
    >
      <span aria-hidden className="truncate text-caption text-text">
        {datum.label}
      </span>
      <RowBars datum={datum} />
      <span aria-hidden className="whitespace-nowrap text-right text-caption tabular-nums text-text">
        {fmtPct(datum.winRate)}
        <span className="ml-1.5 text-micro text-text-dim">n={fmtCount(datum.games)}</span>
      </span>
      {isActive ? <RowTooltip id={tooltipId} datum={datum} /> : null}
    </li>
  );
}

export function CiBarChart({ title, data }: CiBarChartProps) {
  const [active, setActive] = useState<string | null>(null);
  const baseId = useId();
  const rows = useRef<Array<HTMLLIElement | null>>([]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>, index: number) => {
      if (event.key === "Escape") {
        setActive(null);
        return;
      }
      const target = nextIndex(event.key, index, data.length);
      if (target === null) return;
      event.preventDefault();
      rows.current[target]?.focus();
    },
    [data.length],
  );

  if (data.length === 0) return null;
  return (
    <figure className="space-y-2" data-testid="ci-bar-chart">
      <ul role="list" aria-label={title} className="space-y-1">
        {data.map((datum, index) => (
          <ChartRow
            key={datum.key}
            datum={datum}
            tooltipId={`${baseId}-tip-${index}`}
            isActive={active === datum.key}
            register={(node) => {
              rows.current[index] = node;
            }}
            onActivate={setActive}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        ))}
      </ul>
      <figcaption className="text-micro text-text-dim">
        Bar = win rate over decided games · whisker = 95% likely range · dashed line = 50%.
      </figcaption>
      <DataTable title={title} data={data} />
    </figure>
  );
}
