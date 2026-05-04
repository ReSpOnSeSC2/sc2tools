"use client";

import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ZAxis,
} from "recharts";
import { fmtMinutes } from "@/lib/format";

type ChronoEvent = {
  t: number;
  category: string;
  value: number;
};

/** Chrono-boost spending heat-strip — when did Protoss boost what? */
export function ChronoSpendingChart({
  data,
  height = 240,
}: {
  data: ChronoEvent[];
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <ScatterChart margin={{ left: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
          <XAxis
            dataKey="t"
            type="number"
            stroke="#6b7280"
            fontSize={11}
            tickFormatter={(v) => fmtMinutes(v as number)}
            name="Time"
          />
          <YAxis
            dataKey="category"
            type="category"
            stroke="#6b7280"
            fontSize={11}
            width={100}
          />
          <ZAxis dataKey="value" range={[40, 240]} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            contentStyle={{
              background: "#11141b",
              border: "1px solid #1f2533",
              borderRadius: 8,
            }}
            labelFormatter={(t) => fmtMinutes(t as number)}
          />
          <Scatter data={data} fill="#7c8cff" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
