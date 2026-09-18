"use client";

export type WinRateComparisonRow = {
  key: string;
  label: string;
  /** Supplied by the endpoint: not necessarily wins / (wins + losses). */
  rate: number | null;
  games: number;
  wins: number;
  losses: number;
  other?: number;
  /** Optional denominator used to qualify the sample, distinct from all records. */
  sampleSize?: number;
  onSelect?: () => void;
  ariaLabel?: string;
  detail?: string;
};

type Props = {
  rows: WinRateComparisonRow[];
  baseline?: number | null;
  baselineLabel?: string;
  recordLabel?: string;
  smallSampleThreshold?: number;
  rateLabel?: string;
  precision?: 0 | 1;
  ariaLabel?: string;
};

const COLUMNS = "grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_3.5rem] items-center gap-x-2";

/** A common scale with the actual record beside every rate, without hover. */
export function WinRateComparison({
  rows,
  baseline,
  baselineLabel = "Overall",
  recordLabel = "games",
  smallSampleThreshold = 20,
  rateLabel = "Win rate",
  precision = 0,
  ariaLabel = "Win rate comparison",
}: Props) {
  const baselinePct = baseline != null && Number.isFinite(baseline)
    ? Math.max(0, Math.min(100, baseline * 100))
    : null;
  const hasSmallSample = rows.some((row) => {
    const n = row.sampleSize ?? row.games;
    return n > 0 && n < smallSampleThreshold;
  });

  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-micro text-text-muted">
        <span>{rateLabel}</span>
        {baselinePct != null && (
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <span aria-hidden="true" className="h-3 border-l-2 border-dashed border-text-dim" />
            {baselineLabel} {baselinePct.toFixed(precision)}%
          </span>
        )}
      </div>
      <div aria-hidden="true" className={`${COLUMNS} px-2 text-micro tabular-nums text-text-dim`}>
        <span />
        <div className="flex justify-between"><span>0%</span><span className="hidden min-[360px]:inline">50%</span><span>100%</span></div>
        <span />
      </div>
      <ul aria-label={ariaLabel} className="mt-1 divide-y divide-border">
        {rows.map((row) => {
          const sample = row.sampleSize ?? row.games;
          const rate = row.rate != null && Number.isFinite(row.rate) && sample > 0
            ? Math.max(0, Math.min(100, row.rate * 100))
            : null;
          const small = sample > 0 && sample < smallSampleThreshold;
          const other = row.other ?? Math.max(0, row.games - row.wins - row.losses);
          const label = row.games === 1 ? recordLabel.replace(/s$/, "") : recordLabel;
          const record = `${row.games.toLocaleString()} ${label} · ${row.wins.toLocaleString()}W · ${row.losses.toLocaleString()}L${other > 0 ? ` · ${other.toLocaleString()} other` : ""}`;
          const content = (
            <>
              <div className={COLUMNS}>
                <span className="break-words text-caption font-semibold leading-snug text-text">{row.label}</span>
                <div aria-hidden="true" className="relative mx-1 h-2 rounded-full bg-text-dim/10">
                  <span className="absolute inset-y-0 left-1/2 border-l border-text-dim/20" />
                  {rate != null && <>
                    <span className={`absolute inset-y-0 left-0 rounded-full ${small ? "bg-text-dim/35" : "bg-accent/65"}`} style={{ width: `${rate}%` }} />
                    <span className={`absolute -top-0.5 h-3 w-3 -translate-x-1/2 rounded-full border-2 ${small ? "border-text-dim bg-bg-surface" : "border-bg-surface bg-accent"}`} style={{ left: `${rate}%` }} />
                  </>}
                  {baselinePct != null && <span className="absolute -bottom-1 -top-1 border-l-2 border-dashed border-text-dim/70" style={{ left: `${baselinePct}%` }} />}
                </div>
                <span className="text-right text-sm font-semibold tabular-nums text-text">{rate == null ? "—" : `${rate.toFixed(precision)}%`}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-micro text-text-muted">
                <span className="tabular-nums">{row.games === 0 ? "No games" : record}</span>
                {small && <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-text-dim">Small sample{sample !== row.games ? ` · n=${sample.toLocaleString()}` : ""}</span>}
                {row.onSelect && <span className="font-medium text-accent">View games <span aria-hidden="true">↗</span></span>}
              </div>
              {row.detail && <p className="mt-1 text-micro leading-relaxed text-text-dim">{row.detail}</p>}
            </>
          );
          return (
            <li key={row.key}>
              {row.onSelect ? (
                <button type="button" aria-label={row.ariaLabel} onClick={row.onSelect} className="block min-h-11 w-full rounded-lg px-2 py-3 text-left transition-colors hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {content}
                </button>
              ) : <div className="px-2 py-3">{content}</div>}
            </li>
          );
        })}
      </ul>
      {hasSmallSample && <p className="mt-2 text-micro leading-relaxed text-text-dim">Small samples have fewer than {smallSampleThreshold} results and can change sharply after one game.</p>}
    </div>
  );
}
