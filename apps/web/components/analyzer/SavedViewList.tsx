import type { ReactNode } from "react";

export function SavedViewList<T extends { id: string; name: string }>({ views, label, details, actions }: {
  views: readonly T[];
  label: string;
  details?: (view: T) => ReactNode;
  actions: (view: T) => ReactNode;
}) {
  return <ul className="space-y-3" aria-label={label}>
    {views.map(view => <li key={view.id} className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="min-w-0 break-words text-caption">{view.name}</strong>
        {details ? <span className="text-micro text-text-muted">{details(view)}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">{actions(view)}</div>
    </li>)}
  </ul>;
}
