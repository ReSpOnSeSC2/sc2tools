"use client";

import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useChartTheme } from "@/lib/useChartTheme";
import { ADMIN_DAILY_SERIES } from "./adminDailyEvents";
import type { AdminDailyEvent } from "./adminTypes";

export default function AdminDailyChart({ days }: { days: AdminDailyEvent[] }) {
  const theme = useChartTheme();
  const colors = [theme.accentCyan, theme.accent, theme.warning];
  const patterns = [undefined, "6 4", "2 3"];
  return <div aria-hidden="true" className="min-w-0">
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={days} accessibilityLayer={false} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={theme.border} strokeDasharray="3 3" />
        <XAxis dataKey="date" tickFormatter={(date: string) => date.slice(5)} stroke={theme.textDim} tickMargin={5} minTickGap={22} />
        <YAxis allowDecimals={false} stroke={theme.textDim} width={34} />
        <Tooltip contentStyle={{ backgroundColor: theme.bgSurface, borderColor: theme.border, color: theme.text }} />
        <Legend />
        {ADMIN_DAILY_SERIES.map(({ key, label }, index) => (
          <Line key={key} dataKey={key} name={label} type="linear" stroke={colors[index]} strokeWidth={2}
            strokeDasharray={patterns[index]} dot={false} isAnimationActive={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
