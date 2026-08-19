"use client";

/**
 * ReplaySettings — the small popover at the end of the transport dock.
 *
 * Holds the view toggles that belong to the HUD shell: show/hide each
 * rail, and which side the production rail follows.
 *
 * NOT HERE, deliberately: fog of war (Both / Selected / Off) and
 * follow-a-player's-camera. Both are properties of the CANVAS, not of
 * this shell — fog reveals are pushed inside ``MapReplayer``'s
 * ``renderFrame`` (one ``pushFog`` per live unit and building, with no
 * owner filter) and the camera is ``viewRef`` inside the same file.
 * Wiring them means changing ``renderFrame``'s signature and the pan /
 * zoom clamp, which is outside the minimal contract this HUD has with
 * that component. Shipping dead switches would be worse than shipping
 * none; see the handover notes for the exact change each needs.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import type { ReplaySide } from "@/lib/replayHud";
import { sideLabel } from "./replayTheme";

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-caption text-text hover:bg-bg-subtle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-[#3ec0c7]"
      />
    </label>
  );
}

export function ReplaySettings({
  showProductionRail,
  onShowProductionRail,
  showBuildOrderRail,
  onShowBuildOrderRail,
  productionSide,
  onProductionSide,
  myName,
  oppName,
}: {
  showProductionRail: boolean;
  onShowProductionRail: (v: boolean) => void;
  showBuildOrderRail: boolean;
  onShowBuildOrderRail: (v: boolean) => void;
  productionSide: ReplaySide;
  onProductionSide: (side: ReplaySide) => void;
  myName?: string | null;
  oppName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Replay display settings"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={open ? menuId : undefined}
        title="Display settings"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-bg-elevated text-text hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Settings2 className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div
          id={menuId}
          role="group"
          aria-label="Replay display settings"
          className="absolute bottom-full right-0 z-20 mb-2 w-56 overflow-hidden rounded-lg border border-border bg-bg-elevated py-1 shadow-card"
        >
          <p className="px-3 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wider text-text-dim">
            Panels
          </p>
          <ToggleRow
            label="Production rail"
            checked={showProductionRail}
            onChange={onShowProductionRail}
          />
          <ToggleRow
            label="Build order rail"
            checked={showBuildOrderRail}
            onChange={onShowBuildOrderRail}
          />
          <p className="px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-text-dim">
            Production shows
          </p>
          <div className="flex gap-1 px-3 pb-2">
            {(["me", "opp"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onProductionSide(s)}
                aria-pressed={productionSide === s}
                className={`flex-1 truncate rounded-md border px-2 py-1 text-micro font-semibold ${
                  productionSide === s
                    ? "border-accent bg-accent/15 text-text"
                    : "border-border bg-bg-subtle text-text-muted hover:border-accent"
                }`}
              >
                {s === "me" ? sideLabel("me", myName) : sideLabel("opp", null, oppName)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
