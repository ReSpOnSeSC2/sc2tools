"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Save, RotateCcw } from "lucide-react";

export interface SaveBarProps {
  visible: boolean;
  saving?: boolean;
  onSave: () => void;
  onReset?: () => void;
  saveLabel?: string;
  resetLabel?: string;
  message?: ReactNode;
  /** Disable the in-page beforeunload guard. Defaults to false. */
  disableUnloadGuard?: boolean;
}

/**
 * SaveBar — sticky bottom action bar shown only while there are unsaved
 * changes. Responsive: full-width sheet ≤640px (respecting safe-area),
 * floating pill on larger viewports. Pairs with `useDirtyForm`.
 */
export function SaveBar({
  visible,
  saving = false,
  onSave,
  onReset,
  saveLabel = "Save changes",
  resetLabel = "Reset",
  message = "You have unsaved changes",
  disableUnloadGuard = false,
}: SaveBarProps) {
  useEffect(() => {
    if (!visible || disableUnloadGuard) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [visible, disableUnloadGuard]);

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2"
    >
      <div className="pointer-events-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border border-accent-cyan/40 bg-bg-surface px-4 py-3 shadow-[var(--shadow-card)] sm:gap-4">
        <div className="flex min-w-0 items-center gap-2 text-caption text-text">
          <span
            aria-hidden
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-accent-cyan"
          />
          <span className="truncate">{message}</span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {onReset ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={saving}
              iconLeft={<RotateCcw className="h-4 w-4" aria-hidden />}
            >
              <span className="hidden sm:inline">{resetLabel}</span>
              <span className="sm:hidden">Reset</span>
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            loading={saving}
            iconLeft={<Save className="h-4 w-4" aria-hidden />}
          >
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
