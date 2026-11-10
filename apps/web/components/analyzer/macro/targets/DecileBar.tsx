"use client";

/**
 * A league's p10–p90 range as a track, with your median (dot), your
 * league's median (thin tick) and the next league's median (accent tick).
 * Below the league floor there is no range: only the markers that exist.
 * Purely visual; the row's text carries the same numbers for screen readers.
 */
export function DecileBar({ deciles, mine, currentP50, nextP50, label }: {
  deciles: number[] | null;
  mine: number | null;
  currentP50: number | null;
  nextP50: number | null;
  label: string;
}) {
  const values = [deciles?.[0], deciles?.[8], mine, currentP50, nextP50].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length === 0) return null;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.08, 1);
  lo -= pad;
  hi += pad;
  const at = (value: number) => `${(100 * (value - lo)) / (hi - lo)}%`;
  return (
    <div role="img" aria-label={label} className="relative h-4 w-full">
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-bg-elevated" />
      {deciles ? (
        <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-accent-cyan/20" style={{ left: at(deciles[0]), right: `calc(100% - ${at(deciles[8])})` }} />
      ) : null}
      {currentP50 !== null ? <span className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-text-dim" style={{ left: at(currentP50) }} /> : null}
      {nextP50 !== null ? <span className="absolute top-0 h-4 w-0.5 -translate-x-1/2 bg-accent" style={{ left: at(nextP50) }} /> : null}
      {mine !== null ? <span className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-surface bg-accent-cyan" style={{ left: at(mine) }} /> : null}
    </div>
  );
}
