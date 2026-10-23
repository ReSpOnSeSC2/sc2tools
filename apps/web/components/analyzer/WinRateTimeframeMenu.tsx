"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import type { useFilters } from "@/lib/filterContext";
import { PRESETS, shortLabelFor, type PresetId } from "@/lib/datePresets";

/** The timeframes the Win rate card offers, in menu order. */
export const WIN_RATE_PRESET_OPTIONS: PresetId[] = [
  "after_5_0_17",
  "patch_5_0_16",
  "before_5_0_16",
  "current_season",
  "today",
  "last_week",
  "last_7d",
  "this_month",
  "last_30d",
  "last_90d",
  "this_year",
  "last_year",
  "all",
];

function menuItemsIn(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
}

/**
 * The Win rate card's label ("Win rate · 30d") and its timeframe menu
 * (DashboardKpiStrip). The card keeps its own timeframe, so picking one
 * here leaves the global date filter alone.
 *
 * Keyboard: Enter or Space on the button opens the menu on the selected
 * timeframe (↓ and ↑ too); ↑/↓ move and wrap, Home/End jump, Enter or
 * Space picks, Esc closes and returns to the button, Tab closes and
 * moves on. A click outside closes it too.
 */
export function WinRateLabel({
  currentPreset,
  onPick,
  seasons,
}: {
  currentPreset: PresetId;
  onPick: (id: PresetId) => void;
  seasons: ReturnType<typeof useFilters>["seasons"];
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = `Win rate · ${shortLabelFor(currentPreset, seasons)}`;
  const currentSeason = seasons.find((s) => s.isCurrent);

  // Opening puts focus on the selected timeframe, or the first one.
  useEffect(() => {
    if (!open) return;
    const items = menuItemsIn(menuRef.current);
    const selected = items.find((el) => el.getAttribute("aria-checked") === "true");
    (selected ?? items[0])?.focus();
  }, [open]);

  function closeToButton() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = menuItemsIn(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(index < 0 ? -1 : index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      case "Escape":
        event.preventDefault();
        closeToButton();
        break;
      case "Tab":
        // Park focus on the button so Tab (or Shift+Tab) carries on
        // from there once the menu is gone.
        buttonRef.current?.focus();
        setOpen(false);
        break;
      default:
        break;
    }
  }

  return (
    <span className="relative inline-flex items-center gap-1">
      <span>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Change Win Rate timeframe"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
        className="inline-flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>

      {open ? (
        <>
          {/* Click-outside catcher for the pointer. Keyboard users close
              with Esc or Tab, so it stays out of the tab order. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          {/* Opens from the label's left edge: on phones the card sits in
              the left column, so the menu grows toward the screen's middle.
              normal-case undoes the card label's small caps. */}
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Win rate timeframe"
            onKeyDown={onMenuKeyDown}
            className="absolute left-0 top-full z-40 mt-1 w-56 max-w-[80vw] rounded-lg border border-border bg-bg-surface p-1 text-left normal-case tracking-normal shadow-card"
          >
            {WIN_RATE_PRESET_OPTIONS.map((id) => {
              const friendly =
                id === "current_season"
                  ? `Current season${currentSeason ? ` (${currentSeason.number})` : ""}`
                  : PRESETS.find((p) => p.id === id)?.label || id;
              const selected = currentPreset === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  tabIndex={-1}
                  onClick={() => {
                    onPick(id);
                    closeToButton();
                  }}
                  className={[
                    "flex min-h-[40px] w-full items-center rounded px-2 py-1.5 text-left text-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    selected
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:bg-bg-elevated hover:text-text focus:bg-bg-elevated focus:text-text",
                  ].join(" ")}
                >
                  {friendly}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </span>
  );
}
