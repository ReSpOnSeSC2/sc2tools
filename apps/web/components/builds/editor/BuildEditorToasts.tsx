"use client";

import { CheckCircle2, AlertTriangle, AlertCircle, X } from "lucide-react";
import type { BuildEditorToast } from "./BuildEditor.types";

export interface BuildEditorToastsProps {
  toasts: ReadonlyArray<BuildEditorToast>;
  dismiss: (id: string) => void;
}

/**
 * BuildEditorToasts — pinned bottom-right toast strip for the editor.
 * Independent of the global app Toast provider so toasts can be shown
 * inside the modal without coupling.
 */
export function BuildEditorToasts({ toasts, dismiss }: BuildEditorToastsProps) {
  if (!toasts.length) return null;
  return (
    <div
      role="region"
      aria-label="Build editor notifications"
      aria-live="polite"
      className="pointer-events-none fixed bottom-3 right-3 z-[60] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            "pointer-events-auto flex items-center gap-2 rounded-lg border px-3 py-2 text-caption shadow-[var(--shadow-card)] backdrop-blur",
            t.kind === "success"
              ? "border-success/40 bg-success/15 text-success"
              : t.kind === "error"
                ? "border-danger/40 bg-danger/15 text-danger"
                : "border-warning/40 bg-warning/15 text-warning",
          ].join(" ")}
        >
          <ToastIcon kind={t.kind} />
          <span className="flex-1">{t.text}</span>
          {t.action ? (
            <a
              href={t.action.href}
              className="underline underline-offset-2 hover:opacity-80"
            >
              {t.action.label}
            </a>
          ) : null}
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="text-text-dim hover:text-text"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

function ToastIcon({ kind }: { kind: BuildEditorToast["kind"] }) {
  if (kind === "success") {
    return <CheckCircle2 className="h-4 w-4 flex-shrink-0" aria-hidden />;
  }
  if (kind === "error") {
    return <AlertCircle className="h-4 w-4 flex-shrink-0" aria-hidden />;
  }
  return <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden />;
}
