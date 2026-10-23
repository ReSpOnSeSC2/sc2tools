import { formatUsd } from "@/lib/infrastructureCosts";

const PROVIDERS = [
  { id: "render", label: "Render", color: "rgb(var(--accent-cyan))" },
  { id: "mongo", label: "Atlas", color: "rgb(var(--editorial))" },
  { id: "domain", label: "Domain", color: "rgb(var(--signal))" },
  { id: "r2", label: "R2", color: "rgb(var(--player-you))" },
];
export function costBarSegments(lines: ReadonlyArray<{ id: string; approxMonthlyUsd: number }>) {
  return PROVIDERS.map((provider) => ({ ...provider, usd: lines.filter((line) => line.id === provider.id).reduce((total, line) => total + line.approxMonthlyUsd, 0) })).filter((item) => Number.isFinite(item.usd) && item.usd > 0);
}
/** A deterministic, text-labelled chart; it does not fetch or guess usage. */
export function CostBar({ lines }: { lines: ReadonlyArray<{ id: string; approxMonthlyUsd: number }> }) {
  const segments = costBarSegments(lines);
  const total = segments.reduce((sum, item) => sum + item.usd, 0);
  if (!segments.length) return null;
  return <figure className="mb-5 space-y-3">
    <div role="img" aria-label={`Estimated monthly costs: ${segments.map((item) => `${item.label} ${formatUsd(item.usd)}`).join(", ")}. Total ${formatUsd(total)}.`} className="flex h-5 overflow-hidden rounded-md border border-border">
      {segments.map((item) => <span key={item.id} aria-hidden data-provider={item.id} data-cost-usd={item.usd} style={{ width: `${item.usd / total * 100}%`, backgroundColor: item.color }} />)}
    </div>
    <figcaption><ul className="flex flex-wrap gap-x-5 gap-y-2 text-caption text-text-muted">{segments.map((item) => <li key={item.id} className="flex items-center gap-2"><span aria-hidden className="h-3 w-3 rounded-sm" style={{ backgroundColor: item.color }} />{item.label} <span className="font-mono text-text">{formatUsd(item.usd)}</span></li>)}</ul></figcaption>
  </figure>;
}
