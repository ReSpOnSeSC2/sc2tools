"use client";

import type { LossSummary } from "@/lib/mapReplayLosses";
import { getIconPath } from "@/lib/sc2-icons";
import { formatNumber } from "@/lib/i18n/format";

/** How many lost-unit rows a panel lists before folding into "+N". */
const LOSS_ROWS_MAX = 8;

/**
 * One side's units-lost panel under the bare replayer: count and price
 * of everything that died up to the scrub time, plus the trade
 * efficiency against the other side.
 */
export function LossPanel({
  label,
  color,
  losses,
  efficiency,
  showIcons = true,
}: {
  label: string;
  color?: string;
  losses: LossSummary;
  efficiency: number | null;
  showIcons?: boolean;
}) {
  const shown = losses.byUnit.slice(0, LOSS_ROWS_MAX);
  const folded = losses.byUnit.length - shown.length;
  return (
    <div
      className="rounded-md border border-border bg-bg-elevated/60 p-2"
      data-testid={`loss-panel-${label.toLowerCase()}`}
    >
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="whitespace-nowrap">
          <b className={color ? undefined : "text-text"} style={color ? { color } : undefined}>{label}</b>{" "}
          <span className="text-text-muted">units lost</span>
        </span>
        <span
          className="whitespace-nowrap tabular-nums text-text-muted"
          title="Resources the opponent lost per resource this side lost — above 1.00× means this side traded up"
        >
          trade {formatEfficiency(efficiency)}
        </span>
      </div>
      <div className="mt-1 text-caption tabular-nums text-text">
        {losses.count} units · {formatNumber(losses.minerals)} minerals ·{" "}
        {formatNumber(losses.gas)} gas
      </div>
      {shown.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {shown.map((g) => {
            const icon = showIcons ? getIconPath(g.name, "unit") : null;
            return (
              <li
                key={g.name}
                className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-micro tabular-nums text-text-muted"
                title={`${g.count}× ${g.name} — ${formatNumber(g.minerals)} minerals, ${formatNumber(g.gas)} gas`}
              >
                {icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={icon} alt="" aria-hidden className="h-3.5 w-3.5" />
                ) : null}
                <span>
                  {g.count}× {g.name}
                </span>
              </li>
            );
          })}
          {folded > 0 && (
            <li className="inline-flex items-center rounded px-1 py-0.5 text-micro text-text-dim">
              +{folded} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function formatEfficiency(eff: number | null): string {
  if (eff === null) return "—";
  if (!Number.isFinite(eff)) return "∞";
  return `${eff.toFixed(2)}×`;
}
