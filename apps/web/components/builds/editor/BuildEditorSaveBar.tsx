"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";

export interface BuildEditorSaveBarProps {
  ruleCount: number;
  saving: boolean;
  previewLoading: boolean;
  saveError: string | null;
  onCancel: () => void;
  onSave: (andReclassify: boolean) => void;
  /** When "edit", primary button reads "Save changes" instead of "Save build". */
  mode?: "create" | "edit";
  /**
   * Landing-page demo mode: replaces Save build / Save & Reclassify
   * with a sign-up CTA. Cancel still closes the modal so the visitor
   * isn't trapped.
   */
  demoMode?: boolean;
}

/**
 * BuildEditorSaveBar — sticky save footer for the BuildEditor modal.
 *
 * Hosts Cancel + Save build + Save & Reclassify buttons. Save is
 * disabled when there are no rules or while a preview / save call
 * is in flight. The "Save & Reclassify" hint surfaces when a save
 * has been queued for agent-side reclassification.
 */
export function BuildEditorSaveBar({
  ruleCount,
  saving,
  previewLoading,
  saveError,
  onCancel,
  onSave,
  mode = "create",
  demoMode = false,
}: BuildEditorSaveBarProps) {
  if (demoMode) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-caption text-text-muted">
          Demo: rules and preview are local — sign up to save this build to
          your library.
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
          <Link
            href="/sign-up"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-body font-semibold text-white hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Sign up to save
          </Link>
        </div>
      </div>
    );
  }
  // In edit mode the user might be tweaking metadata (name, description,
  // skill level, strategy notes) without touching the rules — so don't
  // gate save on having at least one rule. Create mode still requires
  // a rule, otherwise the saved build is non-functional from the start.
  const requiresRule = mode !== "edit";
  const saveDisabled =
    saving || previewLoading || (requiresRule && ruleCount === 0);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {saveError ? (
        <span
          role="alert"
          className="flex-1 truncate text-caption text-danger"
        >
          {saveError}
        </span>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          onClick={() => onSave(false)}
          disabled={saveDisabled}
          loading={saving}
          title={
            previewLoading
              ? "Wait for the preview to settle…"
              : requiresRule && ruleCount === 0
                ? "Add at least one rule to enable saving."
                : undefined
          }
        >
          {saving ? "Saving…" : mode === "edit" ? "Save changes" : "Save build"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => onSave(true)}
          disabled={saveDisabled}
          title="Save and request the agent to re-bucket past games against this rule set."
        >
          Save & Reclassify
        </Button>
      </div>
    </div>
  );
}
