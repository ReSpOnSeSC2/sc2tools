"use client";

/**
 * The Match timeline's dark read-out card, beside the crosshair.
 *
 * One metric: the clock, each player's value (and whether they were
 * supply blocked), then who is ahead and by how much.
 *
 * Several metrics: a compact table — the clock over one column per
 * player, one row per metric keyed by its line pattern. The leader on
 * each row is underlined in their colour; on a roomy chart a last
 * column gives the margin. A "blocked" tag by the clock, dotted in the
 * players' colours, says who is supply blocked.
 *
 * The card is measured so it sits beside the crosshair and inside the
 * chart. When it cannot clear the crosshair (a phone, a big table), it
 * takes the top or bottom of the plot, whichever hides fewer of the
 * inspected points.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { formatGameClock } from "@/lib/macro";
import { COLOR_OPP, COLOR_YOU, type HoverState } from "./ActiveArmyChartParts";
import type { ChartLayout } from "./activeArmyLayout";
import { LineKey } from "./TimelineControls";
import { describeMetric, formatSigned, metricLead } from "./timelineMetrics";

/** Below this chart width the card drops the margin column. */
const ROOMY_CHART_PX = 420;
const EDGE_PX = 4;
const GAP_PX = 12;
/** A hover marker's radius plus its ring, so a half-hidden point counts. */
const MARKER_R = 7;

const CARD =
  "pointer-events-none absolute z-10 rounded-lg bg-text/[0.94] px-3 py-2 text-micro text-bg shadow-lg ring-1 ring-black/5 backdrop-blur-sm";

export function TimelineTooltip({
  layout,
  hover,
  scaleX,
  myName,
  oppName,
  myBlocked,
  oppBlocked,
}: {
  layout: ChartLayout;
  hover: HoverState;
  /** CSS pixels per layout unit (1 once the chart has measured itself). */
  scaleX: number;
  myName: string;
  oppName: string;
  myBlocked: boolean;
  oppBlocked: boolean;
}) {
  const containerW = layout.width * scaleX;
  const roomy = containerW >= ROOMY_CHART_PX;
  const table = layout.tracks.length > 1;
  const fixedW = table ? null : roomy ? 204 : 176;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState({ w: 0, h: 0 });
  // Re-measure whenever what the card shows can change its size, before
  // paint, so it never lands on the crosshair for a frame.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== measured.w || h !== measured.h) setMeasured({ w, h });
  }, [measured, layout, hover, roomy, myName, oppName, myBlocked, oppBlocked]);
  const width = fixedW ?? (measured.w || (roomy ? 256 : 212));
  const cursorX = hover.xMouseView * scaleX;
  // Beside the crosshair; flipped to its left near the right edge, and
  // never past either side of the chart.
  const flip = cursorX + GAP_PX + width + EDGE_PX > containerW;
  const left = Math.max(
    EDGE_PX,
    Math.min(flip ? cursorX - GAP_PX - width : cursorX + GAP_PX, containerW - width - EDGE_PX),
  );
  const top = cardTop(layout, hover, measured.h, left < cursorX && cursorX < left + width);
  return (
    <div
      ref={cardRef}
      role="status"
      aria-live="polite"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: fixedW != null ? `${fixedW}px` : undefined,
        maxWidth: `${Math.max(0, containerW - 2 * EDGE_PX)}px`,
      }}
      className={`${CARD} ${table ? "w-max" : ""}`}
    >
      {table ? (
        <MetricRows
          layout={layout}
          hover={hover}
          roomy={roomy}
          myName={myName}
          oppName={oppName}
          myBlocked={myBlocked}
          oppBlocked={oppBlocked}
        />
      ) : (
        <SingleMetric
          layout={layout}
          hover={hover}
          myName={myName}
          oppName={oppName}
          myBlocked={myBlocked}
          oppBlocked={oppBlocked}
        />
      )}
    </div>
  );
}

/**
 * The card's top edge: the top of the plot, unless it has to cover the
 * crosshair and the bottom of the plot would hide fewer of the
 * inspected points (or leave them more room).
 */
function cardTop(
  layout: ChartLayout,
  hover: HoverState,
  cardH: number,
  coversCrosshair: boolean,
): number {
  const high = layout.plotTop + 4;
  if (!coversCrosshair || cardH <= 0) return high;
  const ys: number[] = [];
  for (const tr of layout.tracks) {
    for (const p of [hover.my, hover.opp]) {
      const v = p ? tr.metric.read(p) : null;
      if (v != null) ys.push(tr.yOf(v));
    }
  }
  if (ys.length === 0) return high;
  const low = Math.max(high, layout.plotBottom - cardH - 4);
  const hidden = (top: number) =>
    ys.filter((y) => y > top - MARKER_R && y < top + cardH + MARKER_R).length;
  const room = (top: number) =>
    Math.min(...ys.map((y) => Math.max(top - y, y - top - cardH)));
  const [hiddenHigh, hiddenLow] = [hidden(high), hidden(low)];
  if (hiddenLow !== hiddenHigh) return hiddenLow < hiddenHigh ? low : high;
  return room(low) > room(high) ? low : high;
}

interface CardBodyProps {
  layout: ChartLayout;
  hover: HoverState;
  myName: string;
  oppName: string;
  myBlocked: boolean;
  oppBlocked: boolean;
}

function SingleMetric({ layout, hover, myName, oppName, myBlocked, oppBlocked }: CardBodyProps) {
  const metric = layout.tracks[0]?.metric;
  const lead = metric ? metricLead(metric, hover.my, hover.opp) : null;
  return (
    <>
      <div className="text-caption font-bold tabular-nums">{formatGameClock(hover.t)}</div>
      {metric ? (
        <>
          <div aria-hidden className="my-1.5 h-px bg-bg/25" />
          <TooltipRow
            color={COLOR_YOU}
            name={myName}
            value={describeMetric(metric, hover.my)}
            blocked={myBlocked}
          />
          <TooltipRow
            color={COLOR_OPP}
            name={oppName}
            value={describeMetric(metric, hover.opp)}
            blocked={oppBlocked}
          />
          {lead != null ? (
            <div className="mt-1 border-t border-bg/25 pt-1 tabular-nums">
              {leadSentence(lead, myName, oppName)}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function leadSentence(lead: number, myName: string, oppName: string): string {
  if (lead === 0) return "Even";
  return `${lead > 0 ? myName : oppName} ahead by ${Math.abs(lead).toLocaleString()}`;
}

function TooltipRow({
  color,
  name,
  value,
  blocked,
}: {
  color: string;
  name: string;
  value: string;
  blocked: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate font-medium">{name}</span>
        {blocked ? <BlockedTag /> : null}
      </span>
      <span className="flex-shrink-0 font-bold tabular-nums">{value}</span>
    </div>
  );
}

function BlockedTag() {
  return (
    <span className="flex-shrink-0 rounded bg-bg/20 px-1 font-semibold">blocked</span>
  );
}

function MetricRows({
  layout,
  hover,
  roomy,
  myName,
  oppName,
  myBlocked,
  oppBlocked,
}: CardBodyProps & { roomy: boolean }) {
  const nameWidth = roomy ? "max-w-[6.5rem]" : "max-w-[3.5rem]";
  const players = [
    { key: "my", name: myName, color: COLOR_YOU, blocked: myBlocked, underline: "decoration-player-you" },
    { key: "opp", name: oppName, color: COLOR_OPP, blocked: oppBlocked, underline: "decoration-player-opp" },
  ] as const;
  return (
    <table className="border-collapse tabular-nums">
      <caption className="sr-only">Every plotted metric at {formatGameClock(hover.t)}</caption>
      <thead>
        <tr className="border-b border-bg/25">
          <th scope="col" className="pb-1.5 pr-2 text-left align-bottom">
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className="text-caption font-bold">{formatGameClock(hover.t)}</span>
              {myBlocked || oppBlocked ? (
                <span className="inline-flex items-center gap-1 rounded bg-bg/20 px-1 font-semibold">
                  {players.map((p) =>
                    p.blocked ? (
                      <span
                        key={p.key}
                        aria-hidden
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ background: p.color }}
                      />
                    ) : null,
                  )}
                  blocked
                  <span className="sr-only">
                    {" "}
                    (supply: {players.filter((p) => p.blocked).map((p) => p.name).join(" and ")})
                  </span>
                </span>
              ) : null}
            </span>
          </th>
          {players.map((p) => (
            <th key={p.key} scope="col" className="pb-1.5 pl-3 text-right align-bottom font-semibold">
              <span className="inline-flex max-w-full items-center justify-end gap-1">
                <span
                  aria-hidden
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ background: p.color }}
                />
                <span className={`truncate ${nameWidth}`}>{p.name}</span>
              </span>
            </th>
          ))}
          {roomy ? (
            <th scope="col" className="pb-1.5 pl-3 text-right align-bottom font-medium text-bg/70">
              Lead
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {layout.tracks.map(({ metric }, i) => {
          const lead = metricLead(metric, hover.my, hover.opp);
          const pad = i === 0 ? "pt-1.5" : "pt-1";
          return (
            <tr key={metric.key}>
              <th scope="row" className={`pr-2 text-left font-medium ${pad}`}>
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <LineKey dash={metric.dash} />
                  {metric.label}
                </span>
              </th>
              {players.map((p) => {
                const ahead = lead != null && (p.key === "my" ? lead > 0 : lead < 0);
                return (
                  <td key={p.key} className={`whitespace-nowrap pl-3 text-right font-bold ${pad}`}>
                    <span
                      className={
                        ahead ? `underline decoration-2 underline-offset-[3px] ${p.underline}` : undefined
                      }
                    >
                      {describeMetric(metric, p.key === "my" ? hover.my : hover.opp)}
                    </span>
                    {ahead ? <span className="sr-only"> (ahead)</span> : null}
                  </td>
                );
              })}
              {roomy ? (
                <td className={`whitespace-nowrap pl-3 text-right font-medium text-bg/70 ${pad}`}>
                  {lead == null ? "—" : lead === 0 ? "Even" : formatSigned(Math.abs(lead))}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
