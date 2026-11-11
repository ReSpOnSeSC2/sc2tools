"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useRef, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import type { GameSummary } from "@/components/analyzer/game/types";

// The picker and its three smart-chip requests load only on press.
const CompareGamePicker = dynamic(() => import("./CompareGamePicker"), { ssr: false });

export const COMPARE_HINT_KEY = "sc2tools:compare-hint-seen:v1";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/**
 * "Compare…" on the game page: opens the picker for the second game.
 * The first time it appears it carries a short hint, dismissed for good
 * by using the button or by "Got it".
 */
export function CompareGamesButton({ game, buildLabel }: { game: GameSummary; buildLabel?: string | null }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useLocalStorageState(COMPARE_HINT_KEY, false, isBoolean);
  // The stored flag lands in the same commit as ``mounted``, so a
  // returning player never sees the hint flash.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const hintId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const showHint = mounted && !seen;
  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      <Button ref={buttonRef} variant="secondary" size="sm" className="min-h-11" aria-haspopup="dialog"
        aria-describedby={showHint ? hintId : undefined}
        iconLeft={<GitCompareArrows className="h-4 w-4" aria-hidden />}
        onClick={() => { setSeen(true); setOpen(true); }}>
        Compare…
      </Button>
      {showHint ? (
        <div id={hintId} role="note" data-testid="compare-hint" className="flex max-w-sm items-start gap-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-caption text-text">
          <p className="min-w-0 flex-1">New: put this game next to another — timelines, build order and mechanics side by side.</p>
          <Button variant="ghost" size="sm" className="min-h-11 shrink-0" onClick={() => setSeen(true)}>Got it</Button>
        </div>
      ) : null}
      {open ? <CompareGamePicker open onClose={() => setOpen(false)} game={game} buildLabel={buildLabel} returnFocusRef={buttonRef} /> : null}
    </div>
  );
}
