"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cellVerdict, verdictMeta } from "./guideUi";
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
  return `${datum.label}: ${fmtPct(datum.winRate)} win rate, likely range ${fmtCi(datum.ci)}, ${fmtCount(datum.games)} games${players}, ${verdictMeta(cellVerdict(datum)).phrase}`;
}

function RowBars({ datum }: { datum: CiBarDatum }) {
  const patternId = `ci-even-${useId().replaceAll(":", "")}`;
  const even = cellVerdict(datum) === "even";
  const low = toX(datum.ci.low);
  const high = toX(datum.ci.high);
  return (
    <svg width="100%" height={ROW_HEIGHT} aria-hidden="true" focusable="false" className="block min-w-0">
      <defs><pattern id={patternId} width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" className="fill-accent-cyan/40" /><path d="M-1 1L1 -1M0 5L5 0M4 6L6 4" className="stroke-text-muted" strokeWidth="1" /></pattern></defs>
      <rect x="0" y={BAR_Y} width="100%" height={BAR_HEIGHT} rx={BAR_RADIUS} className="fill-bg-elevated" />
      <rect
        x="0"
        y={BAR_Y}
        width={toX(datum.winRate)}
        height={BAR_HEIGHT}
        rx={BAR_RADIUS}
        className={even ? undefined : barTone(datum)}
        fill={even ? `url(#${patternId})` : undefined}
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
  isPinned: boolean;
  tabStop: boolean;
  register: (node: HTMLButtonElement | null) => void;
  onActivate: (key: string | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function ChartRow({ datum, tooltipId, isActive, isPinned, tabStop, register, onActivate, onFocus, onToggle, onKeyDown }: ChartRowProps) {
  return (
    <li className="relative"><button type="button"
      ref={register}
      tabIndex={tabStop ? 0 : -1}
      aria-expanded={isPinned}
      aria-label={ciBarRowLabel(datum)}
      aria-describedby={isActive ? tooltipId : undefined}
      onMouseEnter={() => onActivate(datum.key)}
      onMouseLeave={() => onActivate(null)}
      onFocus={() => { onFocus(); onActivate(datum.key); }}
      onBlur={() => onActivate(null)}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      className="relative grid min-h-11 w-full grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-bg-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto]"
    >
      <span aria-hidden className="truncate text-caption text-text">
        {datum.label}
      </span>
      <RowBars datum={datum} />
      <span aria-hidden className="whitespace-nowrap text-right text-caption tabular-nums text-text">
        {fmtPct(datum.winRate)} {verdictMeta(cellVerdict(datum)).glyph}
        <span className="ml-1.5 text-micro text-text-dim">n={fmtCount(datum.games)}</span>
      </span>
    </button>{isActive ? <RowTooltip id={tooltipId} datum={datum} /> : null}</li>
  );
}

export function CiBarChart({ title, data }: CiBarChartProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const chart = useRef<HTMLElement>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const active = preview ?? pinned;
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!chart.current?.contains(event.target as Node)) { setPinned(null); setPreview(null); } };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const toggle = (key: string) => { setPreview(null); setPinned((old) => old === key ? null : key); };
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
      if (event.key === "Escape") {
        setPinned(null); setPreview(null);
        return;
      }
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(data[index].key); return; }
      const target = nextIndex(event.key, index, data.length);
      if (target === null) return;
      event.preventDefault();
      setActiveIndex(target);
      rows.current[target]?.focus();
  }

  if (data.length === 0) return null;
  return (
    <figure ref={chart} className="space-y-2" data-testid="ci-bar-chart">
      <ul role="list" aria-label={title} className="space-y-1">
        {data.map((datum, index) => (
          <ChartRow
            key={datum.key}
            datum={datum}
            tooltipId={`${baseId}-tip-${index}`}
            isActive={active === datum.key}
            isPinned={pinned === datum.key}
            tabStop={index === Math.min(activeIndex, data.length - 1)}
            register={(node) => {
              rows.current[index] = node;
            }}
            onActivate={setPreview}
            onFocus={() => setActiveIndex(index)}
            onToggle={() => toggle(datum.key)}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        ))}
      </ul>
      <figcaption className="text-micro text-text-dim">
        Bar = win rate over decided games · whisker = 95% likely range · dashed line = 50%.
        {" "}▲ green: clearly above 50% · ● hatched: too close to call · ▼ red: clearly below 50%.
      </figcaption>
      <DataTable title={title} data={data} />
    </figure>
  );
}
