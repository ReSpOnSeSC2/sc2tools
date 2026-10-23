"use client";

export function DossierFilterBar({ filters, onClear }: {
  filters: Array<{ key: string; label: string; value: string; clear: () => void }>;
  onClear: () => void;
}) {
  if (!filters.length) return null;
  return <section role="region" aria-label="Active dossier filters"
    className="sticky top-[var(--chrome-top,3rem)] z-20 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-bg-surface p-3 text-caption">
    <span>Filtered:</span>{filters.map((filter) => <button key={filter.key}
      aria-label={`Remove ${filter.key} filter ${filter.value}`} onClick={filter.clear}
      className="min-h-11 rounded-full border border-accent/40 px-3 text-accent">{filter.label}: {filter.value} ×</button>)}
    <button className="min-h-11 px-2 underline" onClick={onClear}>Clear all</button>
  </section>;
}
