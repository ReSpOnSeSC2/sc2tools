"use client";

import type { ReactNode } from "react";
import { ChevronDown, Pin, PinOff } from "lucide-react";
import type { DockSectionId } from "@/lib/dockLayout";
import { DockButton } from "./DockControls";

export function SectionCard({ id, title, summary, active = false, loading = false, open, pinned, onToggle, onPin, children, padded = true }: {
  id: DockSectionId; title: string; summary: string; active?: boolean; loading?: boolean;
  open: boolean; pinned: boolean; onToggle: () => void; onPin: () => void;
  children: ReactNode; padded?: boolean;
}) {
  const toggleId = `${id}-toggle`, bodyId = `${id}-body`;
  return <section id={id} data-dock-section={id} data-pinned={pinned} className="min-w-0 scroll-mt-20 rounded-lg border border-border bg-bg-surface">
    <div className="flex min-w-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <h2 className="min-w-0 flex-1">
        <DockButton id={toggleId} aria-expanded={open} aria-controls={bodyId} variant="ghost" fullWidth onClick={onToggle} className="min-w-0 justify-start rounded-md px-1.5 text-left font-sans font-semibold">
          <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="min-w-0 truncate">{title}{!open ? <span className="font-normal text-text-muted"> · {loading ? "Loading…" : summary}</span> : null}</span>
          {!open && active && !loading ? <><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-cyan" /><span className="sr-only">Active on stream</span></> : null}
        </DockButton>
      </h2>
      <DockButton variant="ghost" onClick={onPin} aria-pressed={pinned} aria-label={pinned ? `Unpin ${title}` : `Pin ${title} to top`} title={pinned ? "Unpin from top" : "Pin to top"} className="shrink-0 px-2">
        {pinned ? <PinOff aria-hidden className="h-3.5 w-3.5" /> : <Pin aria-hidden className="h-3.5 w-3.5" />}<span className="sr-only">{pinned ? "Unpin" : "Pin"}</span>
      </DockButton>
    </div>
    {/* Keep forms and active chat mounted while folded or reordered. */}
    <div id={bodyId} role="region" aria-labelledby={toggleId} hidden={!open} className={padded ? "min-w-0 p-3" : "min-w-0"}>{children}</div>
  </section>;
}
