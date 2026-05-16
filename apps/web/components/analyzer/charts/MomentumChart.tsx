"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Cell,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";
import { pct1, wrColor } from "@/lib/format";

type MomentumSplit = {
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type SessionPos = {
  pos: number;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
};

type MomentumResponse = {
  sessionGapMinutes: number;
  baseline: MomentumSplit;
  postWin: MomentumSplit;
  postLoss: MomentumSplit;
  sessionPositions: SessionPos[];
};

const COLOR_ACCENT = "#7c8cff";
const COLOR_SUCCESS = "#3ec07a";
const COLOR_DANGER = "#ff6b6b";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";
const COLOR_GRID = "#1f2533";

/**
 * Tilt & Momentum.
 *
 * Two views of the same psychology:
 *   1. Post-win vs post-loss win-rate (left): are you the player
 *      who tilts after a loss, or the one who shrugs it off?
 *   2. Within-session position curve (right): what's your WR on
 *      game 1, 2, 3, … of a session? Warm-up shapes look like an
 *      uphill ramp, fatigue shapes like a slow decline.
 *
 * The reference line on both panels is your overall win rate so a
 * 2-pt swing reads honestly as "barely different" rather than "huge
 * gap above zero".
 */
export function MomentumChart() {
  const { filters, dbRev } = useFilters();
  const { data, isLoading } = useApi<MomentumResponse>(
    `/v1/momentum${filtersToQuery(filters)}#${dbRev}`,
  );

  if (isLoading) {
    return (
      <Card title="Tilt & momentum">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!data || data.baseline.total === 0) {
    return (
      <Card title="Tilt & momentum">
        <EmptyState
          title="Not enough games yet"
          sub="Once you have a handful of back-to-back games on record, the post-win vs post-loss split fills in."
        />
      </Card>
    );
  }

  const baselinePct = Math.round(data.baseline.winRate * 100);
  const minSampleForCurve = 3;
  return (
    <Card title="Tilt & momentum">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Sessions split on a {data.sessionGapMinutes}-min gap · your overall
        win rate is {baselinePct}% (the dashed line on the curve panel) so
        swings read in context.
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TiltPanel
          baseline={data.baseline}
          postWin={data.postWin}
          postLoss={data.postLoss}
        />
        <SessionCurvePanel
          positions={data.sessionPositions}
          baselinePct={baselinePct}
          minSample={minSampleForCurve}
        />
      </div>
      <TiltVerdict
        baseline={data.baseline}
        postWin={data.postWin}
        postLoss={data.postLoss}
      />
    </Card>
  );
}

function TiltPanel({
  baseline,
  postWin,
  postLoss,
}: {
  baseline: MomentumSplit;
  postWin: MomentumSplit;
  postLoss: MomentumSplit;
}) {
  const baselinePct = Math.round(baseline.winRate * 100);
  const rows = useMemo(
    () => [
      {
        label: "After a win",
        pct: postWin.total > 0 ? Math.round(postWin.winRate * 100) : null,
        sample: postWin.total,
        color: wrColor(postWin.winRate, postWin.total),
      },
      {
        label: "After a loss",
        pct: postLoss.total > 0 ? Math.round(postLoss.winRate * 100) : null,
        sample: postLoss.total,
        color: wrColor(postLoss.winRate, postLoss.total),
      },
    ],
    [postWin, postLoss],
  );
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="mb-2 text-caption font-semibold text-text">
        Win rate by previous game
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={rows}
            margin={{ top: 12, right: 16, bottom: 4, left: -8 }}
            layout="vertical"
          >
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(v) => `${v}%`}
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
            />
            <YAxis
              type="category"
              dataKey="label"
              stroke={COLOR_TEXT_DIM}
              fontSize={12}
              width={100}
              tickMargin={4}
            />
            <Tooltip
              cursor={{ fill: "rgba(124,140,255,0.05)" }}
              contentStyle={{
                background: COLOR_BG_SURFACE,
                border: `1px solid ${COLOR_GRID}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(_v: number, _n: string, ctx) => {
                const p = (ctx as { payload?: { pct: number | null; sample: number } }).payload;
                if (!p || p.pct == null) return ["—", "Win rate"];
                return [`${p.pct}% · ${p.sample} games`, "Win rate"];
              }}
            />
            <Bar dataKey="pct" radius={[0, 6, 6, 0]} minPointSize={2}>
              {rows.map((r) => (
                <Cell key={r.label} fill={r.color} fillOpacity={0.85} />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] tabular-nums">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded border border-border bg-bg-elevated/60 px-2 py-1.5"
          >
            <div className="text-text-dim">{r.label}</div>
            <div className="font-semibold" style={{ color: r.color }}>
              {r.pct == null ? "—" : `${r.pct}%`}{" "}
              <span className="text-text-dim">· {r.sample}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionCurvePanel({
  positions,
  baselinePct,
  minSample,
}: {
  positions: SessionPos[];
  baselinePct: number;
  minSample: number;
}) {
  const rows = useMemo(
    () =>
      positions.map((p) => ({
        pos: `#${p.pos}`,
        total: p.total,
        winRatePct: p.total >= minSample ? Math.round(p.winRate * 100) : null,
        confidence: p.total,
      })),
    [positions, minSample],
  );
  return (
    <div className="rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-caption font-semibold text-text">
          Win rate by game # in session
        </span>
        <span className="text-[11px] text-text-dim">
          dots scale with sample size
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-caption text-text-dim">
          No multi-game sessions in this view yet.
        </div>
      ) : (
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
              <XAxis
                dataKey="pos"
                stroke={COLOR_TEXT_DIM}
                fontSize={11}
                tickMargin={4}
              />
              <YAxis
                stroke={COLOR_TEXT_DIM}
                fontSize={11}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v) => `${v}%`}
                width={36}
              />
              <ReferenceLine
                y={50}
                stroke={COLOR_GRID}
                strokeDasharray="2 4"
              />
              <ReferenceLine
                y={baselinePct}
                stroke={COLOR_ACCENT}
                strokeOpacity={0.45}
                strokeDasharray="4 4"
              />
              <Tooltip
                cursor={{ stroke: COLOR_ACCENT, strokeDasharray: "3 3" }}
                contentStyle={{
                  background: COLOR_BG_SURFACE,
                  border: `1px solid ${COLOR_GRID}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: number, _name: string, ctx) => {
                  const p = (ctx as { payload?: { total: number } }).payload;
                  const games = p?.total ?? 0;
                  if (value == null) return [`— · ${games} games`, "Win rate"];
                  return [`${value}% · ${games} games`, "Win rate"];
                }}
              />
              <Line
                type="monotone"
                dataKey="winRatePct"
                stroke={COLOR_ACCENT}
                strokeWidth={2.5}
                dot={renderSampleDot}
                activeDot={{
                  r: 6,
                  fill: COLOR_ACCENT,
                  stroke: COLOR_BG_SURFACE,
                  strokeWidth: 2,
                }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/**
 * Plain-language verdict on the post-win vs post-loss split, so a
 * user who isn't fluent in chart-reading still gets the message.
 * Only shown when both splits have enough sample to mean anything.
 */
function TiltVerdict({
  baseline,
  postWin,
  postLoss,
}: {
  baseline: MomentumSplit;
  postWin: MomentumSplit;
  postLoss: MomentumSplit;
}) {
  if (postWin.total < 5 || postLoss.total < 5) return null;
  const delta = postWin.winRate - postLoss.winRate;
  const baselinePct = Math.round(baseline.winRate * 100);
  if (Math.abs(delta) < 0.05) {
    return (
      <div className="mt-3 rounded-md border border-border bg-bg-elevated/40 px-3 py-2 text-caption text-text-muted">
        Even-keeled — wins and losses don't visibly shift your next-game
        win rate (overall {baselinePct}%, {pct1(postWin.winRate)} after wins,{" "}
        {pct1(postLoss.winRate)} after losses).
      </div>
    );
  }
  const tilting = delta > 0;
  return (
    <div
      className="mt-3 rounded-md border px-3 py-2 text-caption"
      style={{
        borderColor: tilting ? "rgba(255,107,107,0.35)" : "rgba(62,192,122,0.35)",
        background: tilting ? "rgba(255,107,107,0.06)" : "rgba(62,192,122,0.06)",
      }}
    >
      {tilting ? (
        <span>
          <strong className="text-danger">Tilt signal:</strong> you win{" "}
          {pct1(postWin.winRate)} after a win but only {pct1(postLoss.winRate)} after
          a loss ({(delta * 100).toFixed(1)} pt gap).
        </span>
      ) : (
        <span>
          <strong className="text-success">Cool-headed:</strong> you actually
          rebound better after losses ({pct1(postLoss.winRate)}) than off wins
          ({pct1(postWin.winRate)}).
        </span>
      )}
    </div>
  );
}

/**
 * Recharts callback dot — render the data point as an SVG circle
 * whose radius reflects sample size, capped so a single 50-game
 * bucket doesn't dwarf its neighbours. Wrapped in a React fragment
 * because Recharts inspects the return for SVG-ness.
 */
function renderSampleDot(props: {
  cx?: number;
  cy?: number;
  payload?: { total: number; winRatePct: number | null };
}) {
  const { cx, cy, payload } = props;
  if (cx == null || cy == null || !payload || payload.winRatePct == null) {
    return <g />;
  }
  const r = Math.min(7, 3 + Math.sqrt(payload.total));
  const color =
    payload.winRatePct >= 50 ? COLOR_SUCCESS : payload.winRatePct >= 40 ? COLOR_ACCENT : COLOR_DANGER;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={color}
      stroke={COLOR_BG_SURFACE}
      strokeWidth={1.5}
      opacity={0.9}
    />
  );
}
