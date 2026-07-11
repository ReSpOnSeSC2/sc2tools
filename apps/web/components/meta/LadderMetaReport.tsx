"use client";

/**
 * Ladder Meta Radar — the report body for one (league band, matchup).
 *
 * Presentational + client-only (recharts). It takes an already-fetched
 * ``MetaRow`` as props (the public /meta page fetches server-side via
 * lib/serverApi.getJson so crawlers get real HTML — see app/meta/page.tsx)
 * and renders: a headline, a horizontal winrate bar per top opener, and a
 * ranked table (stacked cards on mobile) of games / winrate / prevalence
 * with week-over-week movement arrows.
 *
 * All numbers are corpus-wide aggregates with a k-anonymity floor applied
 * server-side; nothing here is user-specific.
 */

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { useChartTheme, useReducedMotion } from "@/lib/useChartTheme";
import { formatOpenerLabel, type MetaOpener, type MetaRow } from "@/lib/meta";

function pct(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** ISO date (UTC) — deterministic across SSR + client so no hydration
 *  mismatch (locale formatting would differ by machine). */
function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function winRateColor(
  winRate: number,
  theme: ReturnType<typeof useChartTheme>,
): string {
  if (winRate > 0.5) return theme.success;
  if (winRate < 0.5) return theme.danger;
  return theme.textMuted;
}

export function LadderMetaReport({ row }: { row: MetaRow }) {
  const theme = useChartTheme();
  const reducedMotion = useReducedMotion();

  if (row.openers.length === 0) {
    return (
      <p className="rounded-xl border-2 border-line bg-bg-surface p-5 text-body text-text-muted shadow-hard">
        We have {row.n} {row.league} {row.matchup} games logged, but no single
        opener has cleared the reporting threshold yet. Check back as more
        games come in.
      </p>
    );
  }

  const chartData = row.openers.map((o) => ({
    label: formatOpenerLabel(o.build),
    winRate: pct(o.winRate),
    games: o.games,
    raw: o.winRate,
  }));
  const chartHeight = Math.max(160, row.openers.length * 40 + 24);
  const updated = isoDate(row.updatedAt);

  const ariaSummary =
    `Top openers for ${row.league} ${row.matchup}, from ${row.n} ladder games. ` +
    row.openers
      .map(
        (o) =>
          `${formatOpenerLabel(o.build)}: ${pct(o.winRate)} percent win rate over ${o.games} games`,
      )
      .join("; ") +
    ".";

  return (
    <div className="space-y-5">
      <p className="text-body text-text-muted">
        Based on{" "}
        <span className="font-semibold tabular-nums text-text">{row.n}</span>{" "}
        real <span className="font-semibold text-text">{row.league}</span>{" "}
        <span className="font-semibold text-text">{row.matchup}</span> ladder
        games from the SC2 Tools community.
      </p>

      {/* Winrate bars — the at-a-glance "what actually wins" view. */}
      <div
        role="img"
        aria-label={ariaSummary}
        className="w-full min-w-0"
        style={{ height: chartHeight }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 44, bottom: 4, left: 8 }}
            barCategoryGap={8}
          >
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis
              type="category"
              dataKey="label"
              width={132}
              tickLine={false}
              axisLine={false}
              tick={{ fill: theme.textMuted, fontSize: 12 }}
            />
            <Bar
              dataKey="winRate"
              radius={[0, 4, 4, 0]}
              isAnimationActive={!reducedMotion}
              background={{ fill: theme.bgElevated, radius: 4 }}
            >
              {chartData.map((d) => (
                <Cell key={d.label} fill={winRateColor(d.raw, theme)} />
              ))}
              <LabelList
                dataKey="winRate"
                position="right"
                formatter={(v: number) => `${v}%`}
                fill={theme.textDim}
                fontSize={12}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Ranked detail: table on >= md, stacked cards on mobile. */}
      <div className="hidden overflow-hidden rounded-xl border-2 border-line bg-bg-surface shadow-hard md:block">
        <table className="w-full text-caption">
          <caption className="sr-only">
            Top {row.matchup} openers in {row.league} by games played, with
            win rate, prevalence, and week-over-week movement.
          </caption>
          <thead className="border-b-2 border-line bg-bg-elevated text-micro uppercase tracking-wider text-text-dim">
            <tr>
              <th scope="col" className="px-4 py-2 text-left">
                Opener
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Games
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Win rate
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                Prevalence
              </th>
              <th scope="col" className="px-4 py-2 text-right">
                vs last week
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {row.openers.map((o) => (
              <tr key={o.build}>
                <th
                  scope="row"
                  className="px-4 py-2 text-left font-medium text-text"
                >
                  {formatOpenerLabel(o.build)}
                </th>
                <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                  {o.games}
                </td>
                <td
                  className="px-4 py-2 text-right font-semibold tabular-nums"
                  style={{ color: winRateColor(o.winRate, theme) }}
                >
                  {pct(o.winRate)}%
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-text-muted">
                  {pct(o.frequency)}%
                </td>
                <td className="px-4 py-2 text-right">
                  <Delta value={o.winRateDelta} isNew={o.isNew} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 md:hidden">
        {row.openers.map((o) => (
          <li
            key={o.build}
            className="rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-text">
                {formatOpenerLabel(o.build)}
              </span>
              <span
                className="font-display text-lg font-bold tabular-nums"
                style={{ color: winRateColor(o.winRate, theme) }}
              >
                {pct(o.winRate)}%
              </span>
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-caption text-text-muted">
              <div>
                <dt className="text-micro uppercase tracking-wide text-text-dim">
                  Games
                </dt>
                <dd className="tabular-nums">{o.games}</dd>
              </div>
              <div>
                <dt className="text-micro uppercase tracking-wide text-text-dim">
                  Prevalence
                </dt>
                <dd className="tabular-nums">{pct(o.frequency)}%</dd>
              </div>
              <div>
                <dt className="text-micro uppercase tracking-wide text-text-dim">
                  vs last week
                </dt>
                <dd>
                  <Delta value={o.winRateDelta} isNew={o.isNew} />
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <p className="text-micro text-text-dim">
        Win rate is share of decided games. Prevalence is each opener&apos;s
        share of all games in this band. Week-over-week compares against the
        previous nightly snapshot.
        {updated ? <> Updated {updated}.</> : null}
      </p>
    </div>
  );
}

/**
 * Week-over-week movement chip for a winrate delta (a fraction). Renders
 * an up/down/flat arrow in percentage points, or a "new" badge when the
 * opener wasn't ranked in the previous snapshot.
 */
function Delta({
  value,
  isNew,
}: {
  value: MetaOpener["winRateDelta"];
  isNew: boolean;
}) {
  if (isNew || value == null) {
    return (
      <span className="inline-flex items-center rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-micro font-semibold uppercase tracking-wide text-accent">
        New
      </span>
    );
  }
  const points = Math.round(value * 1000) / 10; // percentage points
  if (points === 0) {
    return (
      <span className="inline-flex items-center gap-1 tabular-nums text-text-dim">
        <Minus aria-hidden className="h-3.5 w-3.5" />
        <span className="sr-only">no change</span>
        0
      </span>
    );
  }
  const up = points > 0;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={[
        "inline-flex items-center gap-1 font-semibold tabular-nums",
        up ? "text-success" : "text-danger",
      ].join(" ")}
    >
      <Arrow aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">{up ? "up" : "down"}</span>
      {up ? "+" : ""}
      {points} pts
    </span>
  );
}
