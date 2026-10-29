"use client";

import { useEffect, type ReactNode } from "react";
import { useMacroOverviewFit } from "./useMacroOverviewFit";

/** Fixed mobile overview. Controls and detail-dialog portals stay full size. */
export function MacroOverviewFit({ children, gameId }: { children: ReactNode; gameId?: string | null }) {
  const fit = useMacroOverviewFit(gameId);
  useEffect(() => {
    const viewport = fit.viewportRef.current, view = viewport?.ownerDocument.defaultView;
    if (!viewport || !view) return;
    const handleKey = (event: KeyboardEvent) => scrollOverviewFromKeyboard(event, viewport);
    view.addEventListener("keydown", handleKey);
    return () => view.removeEventListener("keydown", handleKey);
  }, [fit.viewportRef]);
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

/** Native animated key scrolling can chain into the modal after reaching an edge. */
function scrollOverviewFromKeyboard(event: KeyboardEvent, viewport: HTMLDivElement) {
  if (!plainOverviewKey(event, viewport)) return;
  const max = viewport.scrollHeight - viewport.clientHeight;
  const steps: Record<string, number> = { ArrowDown: 40, ArrowUp: -40,
    PageDown: viewport.clientHeight, PageUp: -viewport.clientHeight,
    Home: -viewport.scrollHeight, End: viewport.scrollHeight };
  const step = Object.hasOwn(steps, event.key) ? steps[event.key] : undefined;
  if (step === undefined || max <= 0) return;
  event.preventDefault();
  viewport.scrollTop = Math.max(0, Math.min(max, viewport.scrollTop + step));
}

function plainOverviewKey(event: KeyboardEvent, viewport: HTMLDivElement) {
  const target = event.target;
  if (!(target instanceof Node) || !viewport.contains(target)) return false;
  return !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !overviewEditable(target);
}

function overviewEditable(target: EventTarget) {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select"));
}
