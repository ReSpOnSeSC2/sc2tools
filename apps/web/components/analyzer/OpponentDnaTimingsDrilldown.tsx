"use client";

import { useApi } from "@/lib/clientApi";
import { fmtMinutes, pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type Timing = {
  key: string;
  median: number | null;
  count: number;
};

type ProfileResp = {
  name?: string;
  pulseId?: string;
  matchupLabel?: string;
  medianTimings?: Record<string, Timing>;
  medianTimingsOrder?: string[];
  matchupCounts?: Record<string, number>;
  matchupTimings?: Record<string, Record<string, Timing>>;
  totals?: { total: number; wins: number; losses: number; winRate: number };
};

/**
 * Median key timings drilldown. Shown on top of `OpponentDnaGrid`
 * when a card is clicked. Replaces the legacy modal — slides in from
 * the bottom of the page so callers can keep the grid visible.
 */
export function OpponentDnaTimingsDrilldown({
  pulseId,
  onClose,
}: {
  pulseId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useApi<ProfileResp>(
    `/v1/opponents/${encodeURIComponent(pulseId)}`,
  );

  const totals = data?.totals;
  const order = data?.medianTimingsOrder || [];
  const timings = data?.medianTimings || {};
  const matchupTimings = data?.matchupTimings || {};
  const matchupCounts = data?.matchupCounts || {};

  return (
    <div className="space-y-4 rounded-2xl border border-accent/40 bg-bg-surface p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">
            {data?.name || pulseId} · key timings
          </h3>
          {totals && (
            <p className="mt-1 text-xs text-text-muted">
              {totals.total} games · {totals.wins}W &ndash; {totals.losses}L ·{" "}
              <span style={{ color: wrColor(totals.winRate, totals.total) }}>
                {pct1(totals.winRate)}
              </span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-secondary text-xs"
        >
          ✕ close
        </button>
      </div>

      {isLoading ? (
        <Skeleton rows={4} />
      ) : order.length === 0 ? (
        <Card>
          <EmptyState
            title="No timings recorded"
            sub="Need at least one analysed replay vs this opponent"
          />
        </Card>
      ) : (
        <Card title={`Overall median${data?.matchupLabel ? ` · ${data.matchupLabel}` : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] uppercase text-text-dim">
                  Tech
                </th>
                <th className="px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                  Median time
                </th>
                <th className="px-3 py-2 text-right text-[11px] uppercase text-text-dim">
                  Samples
                </th>
              </tr>
            </thead>
            <tbody>
              {order.map((k) => {
                const t = timings[k];
                if (!t) return null;
                return (
                  <tr key={k} className="border-t border-border">
                    <td className="px-3 py-1.5">{k}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {t.median == null ? "—" : fmtMinutes(t.median)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-text-dim">
                      {t.count}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {Object.keys(matchupTimings).length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {Object.entries(matchupTimings).map(([mu, byTech]) => (
            <Card key={mu} title={`vs ${mu} (${matchupCounts[mu] || 0})`}>
              <ul className="space-y-1 text-xs">
                {Object.entries(byTech).map(([tech, t]) => (
                  <li key={tech} className="flex justify-between">
                    <span>{tech}</span>
                    <span className="tabular-nums text-text-dim">
                      {t.median == null ? "—" : fmtMinutes(t.median)} ·{" "}
                      {t.count}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
