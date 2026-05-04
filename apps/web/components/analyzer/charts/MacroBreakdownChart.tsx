"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

type MacroBucket = {
  bucket: string; // e.g. "0-2 min"
  unspent: number;
  income: number;
  spending: number;
};

/**
 * Stacked bar of unspent / income / spending per minute bucket.
 * Drives the "where did your minerals go" view.
 */
export function MacroBreakdownChart({
  data,
  height = 240,
}: {
  data: MacroBucket[];
  height?: number;
}) {
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: 10, right: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
          <XAxis dataKey="bucket" stroke="#6b7280" fontSize={11} />
          <YAxis stroke="#6b7280" fontSize={11} />
          <Tooltip
            contentStyle={{
              background: "#11141b",
              border: "1px solid #1f2533",
              borderRadius: 8,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="income" stackId="m" fill="#3ec07a" name="Income" />
          <Bar dataKey="spending" stackId="m" fill="#7c8cff" name="Spending" />
          <Bar dataKey="unspent" stackId="m" fill="#ff6b6b" name="Unspent" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
