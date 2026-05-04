"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { fmtMinutes } from "@/lib/format";

type ResourcePoint = {
  t: number;
  minerals: number;
  gas: number;
  supply?: number;
};

/**
 * Minerals + gas (and optional supply) over time. Area chart so the
 * "did I float resources" question is visually obvious.
 */
export function ResourcesChart({
  data,
  height = 240,
}: {
  data: ResourcePoint[];
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ left: 10, right: 10 }}>
          <defs>
            <linearGradient id="mineralsGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#7c8cff" stopOpacity={0.6} />
              <stop offset="95%" stopColor="#7c8cff" stopOpacity={0.0} />
            </linearGradient>
            <linearGradient id="gasGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3ec07a" stopOpacity={0.6} />
              <stop offset="95%" stopColor="#3ec07a" stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
          <XAxis
            dataKey="t"
            stroke="#6b7280"
            fontSize={11}
            tickFormatter={fmtMinutes}
          />
          <YAxis stroke="#6b7280" fontSize={11} />
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
            type="monotone"
            dataKey="minerals"
            stroke="#7c8cff"
            fill="url(#mineralsGrad)"
            strokeWidth={2}
          />
          <Area
            type="monotone"
            dataKey="gas"
            stroke="#3ec07a"
            fill="url(#gasGrad)"
            strokeWidth={2}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
