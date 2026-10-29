"use client";

import type { ReactNode } from "react";
import { useMacroOverviewFit } from "./useMacroOverviewFit";

/** Fixed mobile overview. Controls and detail-dialog portals stay full size. */
export function MacroOverviewFit({ children, gameId }: { children: ReactNode; gameId?: string | null }) {
  const fit = useMacroOverviewFit(gameId);
  const measured = fit.size.width > 0 && fit.size.height > 0;
  return <div className="space-y-2 px-3 sm:px-0" data-macro-overview="">
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
