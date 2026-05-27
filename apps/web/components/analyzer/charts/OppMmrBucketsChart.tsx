"use client";

import { useMemo, useState } from "react";
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
import { wrColor } from "@/lib/format";
import { OppMmrBucketGamesModal } from "./OppMmrBucketGamesModal";

type SelectedBand = {
  lo: number;
  hi: number;
  wins: number;
  losses: number;
  total: number;
};

type OppMmrBucket = {
  lo: number;
  hi: number;
  label: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  avgMmr: number | null;
  minMmr: number | null;
  maxMmr: number | null;
};

type Response = {
  bucketWidth: 50 | 100;
  buckets: OppMmrBucket[];
  unknown: { total: number; wins: number; losses: number };
};

type WidthMode = "auto" | 50 | 100;

const COLOR_ACCENT = "#7c8cff";
const COLOR_GRID = "#1f2533";
const COLOR_BORDER_STRONG = "#2a3142";
const COLOR_TEXT_DIM = "#6b7280";
const COLOR_BG_SURFACE = "#11141b";

/**
 * Win rate by **absolute opponent MMR**, in clean 50- or 100-MMR
 * bands.
 *
 * Bin width is auto-chosen from the data range — tight ranges
 * (≤500 MMR end-to-end) get 50-wide bins so the picture has
 * detail, wider ranges get 100-wide bins so the chart doesn't
 * fan out into 30+ thin bars. A small toggle lets the user
 * override the choice.
 *
 * The chart pairs game-count bars (coloured by the WR ramp) with
 * a WR line, just like the game-length card — same visual idiom
 * keeps the Trends tab feeling like one coherent surface.
 */
export function OppMmrBucketsChart() {
  const { filters, dbRev } = useFilters();
  const [widthMode, setWidthMode] = useState<WidthMode>("auto");
  const [selectedBand, setSelectedBand] = useState<SelectedBand | null>(null);
  const query = useMemo(
    () => ({ ...filters, bucket_width: widthMode }),
    [filters, widthMode],
  );
  const { data, isLoading } = useApi<Response>(
    `/v1/opp-mmr-buckets${filtersToQuery(query)}#${dbRev}`,
  );

  const { rows, baselinePct, totalKnown } = useMemo(() => {
    const buckets = data?.buckets || [];
    let wins = 0;
    let total = 0;
    for (const b of buckets) {
      wins += b.wins;
      total += b.total;
    }
    return {
      rows: buckets.map((b) => ({
        ...b,
        // Format the lo edge as the X-axis tick. Bin width is
        // announced in the caption so a single number is enough.
        tick: String(b.lo),
        winRatePct: b.total > 0 ? Math.round(b.winRate * 100) : null,
        color: wrColor(b.winRate, b.total),
      })),
      baselinePct: total > 0 ? Math.round((wins / total) * 100) : null,
      totalKnown: total,
    };
  }, [data]);

  if (isLoading) {
    return (
      <Card title="Win rate by opponent MMR">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (!data || totalKnown === 0) {
    return (
      <Card title="Win rate by opponent MMR">
        <EmptyState
          title="No MMR-tagged games"
          sub="Once your replays carry opponent MMR, this chart will break your WR out by absolute MMR brackets."
        />
      </Card>
    );
  }

  return (
    <Card
      title="Win rate by opponent MMR"
      right={
        <WidthToggle
          value={widthMode}
          actualWidth={data.bucketWidth}
          onChange={setWidthMode}
        />
      }
    >
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Each bar = a {data.bucketWidth}-MMR band of opponents · bars = games
        played · line = win rate · dashed accent = your average across these
        opponents ({baselinePct}%).
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLOR_GRID} />
            <XAxis
              dataKey="tick"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              tickMargin={4}
              minTickGap={10}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="games"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="wr"
              orientation="right"
              stroke={COLOR_TEXT_DIM}
              fontSize={11}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            <ReferenceLine
              yAxisId="wr"
              y={50}
              stroke={COLOR_BORDER_STRONG}
              strokeDasharray="2 4"
            />
            {baselinePct != null ? (
              <ReferenceLine
                yAxisId="wr"
                y={baselinePct}
                stroke={COLOR_ACCENT}
                strokeOpacity={0.45}
                strokeDasharray="4 4"
              />
            ) : null}
            <Tooltip
              cursor={{ fill: "rgba(124,140,255,0.04)" }}
              contentStyle={{
                background: COLOR_BG_SURFACE,
                border: `1px solid ${COLOR_GRID}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(_v: string, ctx) => {
                const payload = Array.isArray(ctx) && ctx[0]?.payload;
                if (!payload) return _v;
                return `${payload.lo}–${payload.hi - 1} MMR`;
              }}
              formatter={(value, name, ctx) => {
                const n = typeof value === "number" ? value : Number(value);
                if (name === "winRatePct") {
                  if (value == null || !Number.isFinite(n)) return ["—", "Win rate"];
                  return [`${n}%`, "Win rate"];
                }
                if (name === "total") {
                  const p = (ctx as { payload?: OppMmrBucket }).payload;
                  const sub =
                    p?.avgMmr != null ? ` · avg ${p.avgMmr} MMR` : "";
                  return [`${n} games${sub}`, "Sample"];
                }
                return [String(value), String(name)];
              }}
            />
            <Bar
              yAxisId="games"
              dataKey="total"
              radius={[4, 4, 0, 0]}
              minPointSize={3}
            >
              {rows.map((r) => (
                <Cell key={r.lo} fill={r.color} fillOpacity={0.85} />
              ))}
            </Bar>
            <Line
              yAxisId="wr"
              type="linear"
              dataKey="winRatePct"
              stroke={COLOR_ACCENT}
              strokeWidth={2.5}
              dot={{ r: 3, fill: COLOR_ACCENT }}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <BucketTable
        rows={rows}
        unknown={data.unknown}
        totalKnown={totalKnown}
        onSelect={setSelectedBand}
      />
      <OppMmrBucketGamesModal
        band={selectedBand}
        onClose={() => setSelectedBand(null)}
      />
    </Card>
  );
}

function WidthToggle({
  value,
  actualWidth,
  onChange,
}: {
  value: WidthMode;
  actualWidth: 50 | 100;
  onChange: (mode: WidthMode) => void;
}) {
  // "Auto" mode shows the actually-picked width as a small badge so
  // the user can see what was chosen without flipping back to read it.
  const options: Array<{ id: WidthMode; label: string; sub?: string }> = [
    { id: "auto", label: "Auto", sub: `${actualWidth}` },
    { id: 50, label: "50" },
    { id: 100, label: "100" },
  ];
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className="text-text-dim">Width</span>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          aria-pressed={value === opt.id}
          className={[
            "rounded px-2 py-0.5",
            value === opt.id
              ? "bg-accent/20 text-accent ring-1 ring-accent/40"
              : "bg-bg-elevated text-text-muted hover:text-text",
          ].join(" ")}
        >
          {opt.label}
          {opt.sub ? (
            <span className="ml-1 text-text-dim tabular-nums">({opt.sub})</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function BucketTable({
  rows,
  unknown,
  totalKnown,
  onSelect,
}: {
  rows: Array<OppMmrBucket & { color: string }>;
  unknown: { total: number };
  totalKnown: number;
  onSelect: (band: SelectedBand) => void;
}) {
  // Hide buckets with no games to avoid a wall of "no games" tiles on
  // wide MMR ranges. The chart itself still spans the full range.
  const played = rows.filter((r) => r.total > 0);
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-[10px] text-text-dim">
        Tap a band to list the games behind it.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {played.map((r) => (
          <button
            key={r.lo}
            type="button"
            onClick={() =>
              onSelect({
                lo: r.lo,
                hi: r.hi,
                wins: r.wins,
                losses: r.losses,
                total: r.total,
              })
            }
            aria-label={`List the ${r.total} game${
              r.total === 1 ? "" : "s"
            } against ${r.lo}–${r.hi - 1} MMR opponents`}
            className="rounded border border-border bg-bg-elevated/50 px-2.5 py-2 text-left transition-colors hover:border-border-strong hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-1.5">
              <span className="whitespace-nowrap text-[11px] font-semibold text-text">
                {r.lo}–{r.hi - 1}
              </span>
              <span
                className="whitespace-nowrap text-sm font-semibold tabular-nums"
                style={{ color: r.color }}
              >
                {Math.round(r.winRate * 100)}%
              </span>
            </div>
            <div className="mt-0.5 text-[10px] tabular-nums text-text-dim">
              {r.wins}W · {r.losses}L · {r.total} game{r.total === 1 ? "" : "s"}
            </div>
          </button>
        ))}
      </div>
      {unknown.total > 0 ? (
        <div className="mt-2 text-[10px] text-text-dim">
          Plus {unknown.total.toLocaleString()} game
          {unknown.total === 1 ? "" : "s"} with missing opponent MMR (not shown
          above) · {totalKnown.toLocaleString()} game
          {totalKnown === 1 ? "" : "s"} plotted.
        </div>
      ) : null}
    </div>
  );
}
