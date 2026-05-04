"use client";

import { useMemo } from "react";
import { fmtMinutes } from "@/lib/format";
import { Card, EmptyState } from "@/components/ui/Card";

type BuildItem = {
  t: number;
  name: string;
  category?: string;
  supply?: number;
};

const CATEGORY_COLOURS: Record<string, string> = {
  unit: "#7c8cff",
  building: "#e6b450",
  upgrade: "#3ec07a",
  ability: "#ff9d6c",
  worker: "#9aa3b2",
};

export function BuildOrderTimeline({
  items,
  durationSec,
  title = "Build order",
}: {
  items: BuildItem[];
  durationSec?: number;
  title?: string;
}) {
  const dur = durationSec || (items.length ? items[items.length - 1].t + 30 : 60);

  const grouped = useMemo(() => {
    const cats = new Map<string, BuildItem[]>();
    for (const it of items) {
      const c = it.category || "unit";
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c)!.push(it);
    }
    return Array.from(cats.entries());
  }, [items]);

  if (items.length === 0) {
    return (
      <Card title={title}>
        <EmptyState title="No build order recorded" />
      </Card>
    );
  }

  return (
    <Card title={title}>
      <div className="space-y-2">
        {grouped.map(([cat, list]) => (
          <div key={cat}>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-text-dim">
              {cat}
            </div>
            <div className="relative h-8 rounded bg-bg-elevated">
              {list.map((it, i) => {
                const left = `${(it.t / dur) * 100}%`;
                return (
                  <span
                    key={i}
                    title={`${fmtMinutes(it.t)} — ${it.name}${it.supply ? ` @${it.supply}` : ""}`}
                    className="absolute top-1 flex h-6 items-center justify-center rounded px-1.5 text-[10px] font-medium text-white"
                    style={{
                      left,
                      transform: "translateX(-50%)",
                      background: CATEGORY_COLOURS[cat] || "#7c8cff",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {it.name}
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between text-[10px] text-text-dim">
        <span>0:00</span>
        <span>{fmtMinutes(dur / 2)}</span>
        <span>{fmtMinutes(dur)}</span>
      </div>
    </Card>
  );
}
