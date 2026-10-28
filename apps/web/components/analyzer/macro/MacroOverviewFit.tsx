"use client";

import type { ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { useMacroOverviewFit } from "./useMacroOverviewFit";

const CONTROL = "inline-flex h-11 min-w-11 items-center justify-center rounded-md border border-border bg-bg-surface px-3 text-caption font-semibold text-text hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-50";

/** Only the overview is transformed. Controls and detail-dialog portals stay full size. */
export function MacroOverviewFit({ children, gameId }: { children: ReactNode; gameId?: string | null }) {
  const fit = useMacroOverviewFit(gameId);
  const measured = fit.size.width > 0 && fit.size.height > 0;
  return <div className="space-y-2 px-3 sm:px-0" data-macro-overview="">
    {fit.supported ? <div role="group" aria-label="Timeline and armies zoom" data-timeline-control="" className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={fit.reset} aria-pressed={fit.fitted} className={CONTROL}>Fit</button>
      <button type="button" onClick={() => fit.step(-1)} disabled={fit.scale <= fit.fit + 0.001} aria-label="Zoom out timeline and armies" className={CONTROL}><Minus className="h-4 w-4" aria-hidden /></button>
      <button type="button" onClick={() => fit.step(1)} disabled={fit.scale >= 1.5} aria-label="Zoom in timeline and armies" className={CONTROL}><Plus className="h-4 w-4" aria-hidden /></button>
      <span className="text-micro tabular-nums text-text-muted" aria-label={`Overview scale ${Math.round(fit.scale * 100)} percent`}>{Math.round(fit.scale * 100)}%</span>
      <span className="min-w-0 text-micro text-text-muted">Zoom in for detail; Fit shows both armies.</span>
    </div> : null}
    <div ref={fit.viewportRef} data-macro-overview-viewport="" role="region" aria-label="Timeline and both armies"
      className="max-w-full overflow-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      style={measured ? { maxHeight: fit.size.availableHeight } : undefined}>
      <div data-macro-overview-reservation="" className="relative" style={measured ? { width: fit.logicalWidth * fit.scale, height: Math.ceil(fit.size.height * fit.scale), overflow: "clip" } : undefined}>
        <div ref={fit.contentRef} data-macro-overview-content="" className="space-y-3 p-1" style={{ width: fit.size.width > 0 ? fit.logicalWidth : undefined,
          ...(measured ? { position: "absolute", left: 0, top: 0, transform: `scale(${fit.scale})`, transformOrigin: "top left" } : {}) }}>
          {children}
        </div>
      </div>
    </div>
  </div>;
}
