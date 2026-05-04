"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { useApi } from "@/lib/clientApi";
import { useFilters, filtersToQuery } from "@/lib/filterContext";
import { Card } from "@/components/ui/Card";

type ActivityResp = {
  byHour?: Record<string, number>;
  byDow?: Record<string, number>;
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ActivityCharts() {
  const { filters, dbRev } = useFilters();
  const { data } = useApi<ActivityResp>(
    `/v1/summary${filtersToQuery(filters)}#${dbRev}`,
  );

  const byHour = useMemo(() => {
    const h = data?.byHour || {};
    return Array.from({ length: 24 }, (_, i) => ({
      hour: `${i}h`,
      games: h[String(i)] || 0,
    }));
  }, [data]);

  const byDow = useMemo(() => {
    const d = data?.byDow || {};
    return DOW_LABELS.map((lbl, i) => ({
      day: lbl,
      games: d[String(i)] || 0,
    }));
  }, [data]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card title="Activity by hour">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byHour}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
              <XAxis dataKey="hour" stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "#11141b",
                  border: "1px solid #1f2533",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="games" fill="#7c8cff" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="Activity by day of week">
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byDow}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2533" />
              <XAxis dataKey="day" stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={11} />
              <Tooltip
                contentStyle={{
                  background: "#11141b",
                  border: "1px solid #1f2533",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="games" fill="#3ec07a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
