"use client";

import type { ReactNode } from "react";

/**
 * A single value row inside a chart tooltip. `label` is the dim
 * left-hand caption, `value` the bright right-hand readout, and the
 * optional `dot` paints a small colour swatch (used by the
 * multi-series charts to tie a row back to its line).
 */
export type ChartTooltipRow = {
  key?: string | number;
  label: ReactNode;
  value: ReactNode;
  dot?: string;
};

const BG = "#11141b";
const BORDER = "#1f2533";
const HEADER = "#7c8cff";
const ROW_LABEL = "#9aa3b2";
const ROW_VALUE = "#e5e7eb";

/**
 * Shared tooltip box for every Recharts chart on the analyzer.
 *
 * Recharts' default tooltip colours each row from the series' own
 * stroke/fill, which means a dark bar (e.g. a low-sample bucket on the
 * WR colour ramp) renders near-black text on the near-black tooltip
 * background — unreadable. Rather than fight that per-chart with
 * `itemStyle`/`labelStyle` overrides, every chart renders its tooltip
 * through this component, which pins the header, captions, and values
 * to fixed legible colours and lays them out so all data stays visible
 * in the box on both mobile and desktop.
 *
 * Pass it to Recharts via the `content` prop with a render callback:
 *
 *   <Tooltip content={({ active, payload, label }) =>
 *     active && payload?.length ? (
 *       <ChartTooltip header={fmt(label)} rows={[...]} />
 *     ) : null
 *   } />
 */
export function ChartTooltip({
  header,
  rows,
  headerColor = HEADER,
}: {
  header?: ReactNode;
  rows: ChartTooltipRow[];
  headerColor?: string;
}) {
  if (!rows.length) return null;
  const showHeader = header != null && header !== "";
  return (
    <div
      style={{
        background: BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        padding: "6px 10px",
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        maxWidth: 260,
      }}
    >
      {showHeader ? (
        <div style={{ color: headerColor, fontWeight: 600, marginBottom: 4 }}>
          {header}
        </div>
      ) : null}
      {rows.map((r, i) => (
        <div
          key={r.key ?? i}
          style={{ display: "flex", alignItems: "center", gap: 6 }}
        >
          {r.dot ? (
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 9999,
                background: r.dot,
                flex: "0 0 auto",
              }}
            />
          ) : null}
          <span style={{ color: ROW_LABEL }}>{r.label}</span>
          <span
            style={{
              marginLeft: "auto",
              paddingLeft: 12,
              color: ROW_VALUE,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}
