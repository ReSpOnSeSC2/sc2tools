"use client";

import type { RefObject } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";

export type ConfirmationStep = "closed" | "review" | "final";

export interface CommunityRemoveDialogProps {
  step: ConfirmationStep;
  title: string;
  acknowledged: boolean;
  removing: boolean;
  error: string | null;
  finalAcknowledgementRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onContinue: () => void;
  onBack: () => void;
  onAcknowledge: (acknowledged: boolean) => void;
  onRemove: () => void;
}

/**
 * The two confirmations for removing a published build from Community. CommunityBuildOwnerControls owns the state
 * and the request, and loads this on demand, so the dialog code stays out of Community's first-load JavaScript.
 *
 * Example:
 *   <CommunityRemoveDialog step={step} title={title} onRemove={removeFromCommunity} ... />
 */
export function CommunityRemoveDialog({
  step,
  title,
  acknowledged,
  removing,
  error,
  finalAcknowledgementRef,
  onClose,
  onContinue,
  onBack,
  onAcknowledge,
  onRemove,
}: CommunityRemoveDialogProps) {
  return (
    <Modal
      open={step !== "closed"}
      onClose={onClose}
      title={
        step === "review"
          ? `Remove “${title}” from Community?`
          : "Final confirmation"
      }
      description={
        step === "review"
          ? "First confirmation: review exactly what will change."
          : "Second confirmation: approve the removal before it is submitted."
      }
      size="sm"
      hideClose={removing}
      disableScrimClose={removing}
      footer={
        <ModalActions className="w-full justify-end">
          {step === "review" ? (
            <>
              <Button type="button" variant="secondary" onClick={onClose}>
                Keep published
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={onContinue}
              >
                Continue
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={onBack}
                disabled={removing}
              >
                Go back
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={onRemove}
                loading={removing}
                disabled={!acknowledged}
              >
                Remove from Community
              </Button>
            </>
          )}
        </ModalActions>
      }
    >
      {step === "review" ? (
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-caption text-text-muted">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 flex-none text-warning"
              aria-hidden
            />
            <p>
              The public page, votes, and Community search result will be
              hidden. Anyone using its public link will no longer see it.
            </p>
          </div>
          <p className="text-caption text-text-muted">
            Your private build, rules, notes, and replay matches stay safely
            in your build library. You can publish the build again later.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex min-h-[52px] cursor-pointer items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3">
            <input
              ref={finalAcknowledgementRef}
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
              disabled={removing}
              className="mt-0.5 h-5 w-5 flex-none accent-[var(--danger)]"
            />
            <span className="text-caption text-text">
              I understand this will remove <strong>“{title}”</strong> from
              the public Community section.
            </span>
          </label>
          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
            >
              {error}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
