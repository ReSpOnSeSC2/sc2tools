"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";

type ConfirmationStep = "closed" | "review" | "final";

type MeOwnerProbe = {
  userId: string;
};

export interface CommunityBuildOwnerControlsProps {
  slug: string;
  title: string;
  ownerUserId: string;
  compact?: boolean;
  redirectAfterRemove?: boolean;
}

/**
 * Owner-only control for removing a published build from Community.
 *
 * The API remains the authority for ownership. The /v1/me comparison only
 * keeps the destructive affordance out of sight for everyone else; DELETE
 * /v1/community/builds/:slug performs the definitive owner check.
 */
export function CommunityBuildOwnerControls({
  slug,
  title,
  ownerUserId,
  compact = false,
  redirectAfterRemove = false,
}: CommunityBuildOwnerControlsProps) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data: me } = useApi<MeOwnerProbe>("/v1/me");
  const [step, setStep] = useState<ConfirmationStep>("closed");
  const [acknowledged, setAcknowledged] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finalAcknowledgementRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== "final") return;
    finalAcknowledgementRef.current?.focus();
  }, [step]);

  function openReview() {
    setAcknowledged(false);
    setError(null);
    setStep("review");
  }

  const close = useCallback(() => {
    if (removing) return;
    setAcknowledged(false);
    setError(null);
    setStep("closed");
  }, [removing]);

  if (!me || me.userId !== ownerUserId) return null;

  function continueToFinal() {
    setError(null);
    setStep("final");
  }

  async function removeFromCommunity() {
    if (!acknowledged || removing) return;
    setRemoving(true);
    setError(null);
    try {
      await apiCall<void>(
        getToken,
        `/v1/community/builds/${encodeURIComponent(slug)}`,
        { method: "DELETE" },
      );
      setStep("closed");
      toast.success("Removed from Community", {
        description: `“${title}” is still saved in your private build library.`,
      });
      if (redirectAfterRemove) {
        router.replace("/community");
      }
      router.refresh();
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "The Community listing could not be removed. Try again.";
      setError(message);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={compact ? "ghost" : "danger"}
        size={compact ? "sm" : "md"}
        fullWidth={!compact}
        iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
        onClick={openReview}
        className={
          compact
            ? "min-h-[44px] bg-bg-surface/95 text-danger hover:bg-danger/10"
            : undefined
        }
        aria-label={compact ? `Remove “${title}” from Community` : undefined}
      >
        Remove{compact ? "" : " from Community"}
      </Button>

      <Modal
        open={step !== "closed"}
        onClose={close}
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
                <Button type="button" variant="secondary" onClick={close}>
                  Keep published
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={continueToFinal}
                >
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setAcknowledged(false);
                    setError(null);
                    setStep("review");
                  }}
                  disabled={removing}
                >
                  Go back
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={removeFromCommunity}
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
                onChange={(event) => setAcknowledged(event.target.checked)}
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
    </>
  );
}
