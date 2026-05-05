"use client";

import { Button } from "@/components/ui/Button";

export interface BuildEditorSaveBarProps {
  ruleCount: number;
  saving: boolean;
  previewLoading: boolean;
  saveError: string | null;
  onCancel: () => void;
  onSave: (andReclassify: boolean) => void;
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
}: BuildEditorSaveBarProps) {
  const saveDisabled = saving || previewLoading || ruleCount === 0;
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
              : ruleCount === 0
                ? "Add at least one rule to enable saving."
                : undefined
          }
        >
          {saving ? "Saving…" : "Save build"}
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
