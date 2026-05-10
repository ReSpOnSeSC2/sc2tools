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
import { wrColor } from "@/lib/format";

type LengthBucketRow = {
  bucket: "<8m" | "8–15m" | "15–25m" | "25m+";
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  avgSec: number;
};

type LengthBucketResponse = {
  buckets: LengthBucketRow[];
};

const ORDER: LengthBucketRow["bucket"][] = ["<8m", "8–15m", "15–25m", "25m+"];

/**
 * WR by game-length bucket — surfaces patterns like "I coinflip in
 * long games" or "I close fast games well".
 *
 * Composed chart: bars are game counts (wins stacked on losses) using
 * the analyzer's WR colour ramp; the secondary axis carries the WR
 * line. A 50% reference line keeps the coinflip baseline visible.
 */
export function GameLengthWrChart() {
  const { filters, dbRev } = useFilters();
  const { data, isLoading } = useApi<LengthBucketResponse>(
    `/v1/length-buckets${filtersToQuery(filters)}#${dbRev}`,
  );

  const rows = useMemo(() => {
    const byBucket = new Map<string, LengthBucketRow>();
    for (const row of data?.buckets || []) {
      byBucket.set(row.bucket, row);
    }
    return ORDER.map((b) => {
      const row = byBucket.get(b);
      if (row && row.total > 0) {
        return {
          bucket: b,
          wins: row.wins,
          losses: row.losses,
          total: row.total,
          winRatePct: Math.round(row.winRate * 100),
          color: wrColor(row.winRate, row.total),
        };
      }
      return {
        bucket: b,
        wins: 0,
        losses: 0,
        total: 0,
        winRatePct: 0,
        color: "#3a4252",
      };
    });
  }, [data]);

  const totalGames = rows.reduce((acc, r) => acc + r.total, 0);

  if (isLoading) {
    return (
      <Card title="Win rate by game length">
        <Skeleton rows={3} />
      </Card>
    );
  }

  if (totalGames === 0) {
    return (
      <Card title="Win rate by game length">
        <EmptyState
          title="No games to bucket"
          sub="Game-length analysis becomes useful once a few games of varied length are on record."
        />
      </Card>
    );
  }

  return (
    <Card title="Win rate by game length">
      <p className="-mt-1 mb-3 text-caption text-text-dim">
        Bar = games played · Line = win rate · 50% reference is the coinflip baseline.
      </p>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 24, bottom: 0, left: -8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
            <XAxis dataKey="bucket" stroke="#6b7280" fontSize={11} />
            <YAxis
              yAxisId="games"
              stroke="#6b7280"
              fontSize={11}
              allowDecimals={false}
              label={{
                value: "Games",
                angle: -90,
                position: "insideLeft",
                style: { fill: "#6b7280", fontSize: 10 },
                offset: 18,
              }}
            />
            <YAxis
              yAxisId="wr"
              orientation="right"
              stroke="#6b7280"
              fontSize={11}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
              label={{
                value: "WR",
                angle: 90,
                position: "insideRight",
                style: { fill: "#6b7280", fontSize: 10 },
                offset: 12,
              }}
            />
            <ReferenceLine
              yAxisId="wr"
              y={50}
              stroke="#3a4252"
              strokeDasharray="2 4"
            />
            <Tooltip
              contentStyle={{
                background: "#11141b",
                border: "1px solid #1f2533",
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => {
                if (name === "winRatePct") return [`${value}%`, "Win rate"];
                if (name === "total") return [value, "Games"];
                return [value, name];
              }}
            />
            <Bar
              yAxisId="games"
              dataKey="total"
              radius={[4, 4, 0, 0]}
              minPointSize={3}
            >
              {rows.map((r) => (
                <Cell key={r.bucket} fill={r.color} fillOpacity={0.85} />
              ))}
            </Bar>
            <Line
              yAxisId="wr"
              type="linear"
              dataKey="winRatePct"
              stroke="#7c8cff"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#7c8cff" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map((r) => (
          <div
            key={r.bucket}
            className="rounded border border-border bg-bg-elevated/50 px-3 py-2"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-caption font-semibold text-text">
                {r.bucket}
              </span>
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: r.color }}
              >
                {r.total > 0 ? `${r.winRatePct}%` : "—"}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-text-dim">
              {r.total > 0
                ? `${r.wins}W · ${r.losses}L · ${r.total} games`
                : "no games"}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
