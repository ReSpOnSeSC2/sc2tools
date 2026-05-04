"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { fmtMinutes } from "@/lib/format";

type GameDetailPoint = {
  t: number;
  income?: number;
  spending?: number;
  army?: number;
  workers?: number;
};

/**
 * The big "single game macro overview" chart with income/spending
 * lines, army value area, and worker count overlay.
 */
export function GameDetailChart({
  data,
  height = 320,
}: {
  data: GameDetailPoint[];
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ left: 10, right: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
          <XAxis
            dataKey="t"
            stroke="#6b7280"
            fontSize={11}
            tickFormatter={fmtMinutes}
          />
          <YAxis yAxisId="left" stroke="#6b7280" fontSize={11} />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#6b7280"
            fontSize={11}
          />
          <Tooltip
            contentStyle={{
              background: "#11141b",
              border: "1px solid #1f2533",
              borderRadius: 8,
            }}
            labelFormatter={(t) => fmtMinutes(t as number)}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area
            yAxisId="left"
            type="monotone"
            dataKey="army"
            fill="#7c8cff33"
            stroke="#7c8cff"
            strokeWidth={2}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="income"
            stroke="#3ec07a"
            strokeWidth={1.5}
            dot={false}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="spending"
            stroke="#e6b450"
            strokeWidth={1.5}
            dot={false}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="workers"
            stroke="#ff9d6c"
            strokeWidth={1.2}
            strokeDasharray="3 3"
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
