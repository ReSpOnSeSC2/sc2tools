"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { apiCall } from "@/lib/clientApi";
import { CommunityOwnerMenu } from "./CommunityOwnerMenu";
import type { CommunityRemoveDialogProps, ConfirmationStep } from "./CommunityRemoveDialog";
import { useOwnerBuilds } from "./useOwnerBuilds";

type RemoveDialogProps = CommunityRemoveDialogProps & { onUnavailable: () => void };

const loadRemoveDialog = () => import("./CommunityRemoveDialog");

// The removal dialog (and the dialog code under it) loads once an owner's controls show, outside Community's
// first-load JavaScript. A chunk that cannot load says so instead of leaving Remove doing nothing.
const CommunityRemoveDialog = dynamic<RemoveDialogProps>(
  () => loadRemoveDialog().then((module) => module.CommunityRemoveDialog, () => RemoveDialogUnavailable),
  { ssr: false },
);

function RemoveDialogUnavailable({ step, onUnavailable }: RemoveDialogProps) {
  useEffect(() => {
    if (step !== "closed") onUnavailable();
  }, [step, onUnavailable]);
  return null;
}

export interface CommunityBuildOwnerControlsProps {
  slug: string;
  title: string;
  /** Deprecated public hint; ownership is verified by the owner-only API. */
  ownerUserId?: string;
  compact?: boolean;
  redirectAfterRemove?: boolean;
}

/**
 * Owner-only control for removing a published build from Community.
 *
 * The API remains the authority for ownership. Membership in the authenticated
 * owner's build-stat list keeps the affordance out of sight for everyone else
 * without exposing a stable owner id on anonymous public rows; DELETE still
 * performs the definitive owner check.
 */
export function CommunityBuildOwnerControls({
  slug,
  title,
  compact = false,
  redirectAfterRemove = false,
}: CommunityBuildOwnerControlsProps) {
  const router = useRouter();
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data: ownerStats } = useOwnerBuilds();
  const [step, setStep] = useState<ConfirmationStep>("closed");
  // Mounted on first open and kept, so the dialog opens and closes (and returns focus) as one Modal.
  const [dialogMounted, setDialogMounted] = useState(false);
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
    setDialogMounted(true);
  }

  const close = useCallback(() => {
    if (removing) return;
    setAcknowledged(false);
    setError(null);
    setStep("closed");
  }, [removing]);

  const dialogUnavailable = useCallback(() => {
    setStep("closed");
    toast.error("Couldn’t open the removal dialog", { description: "Reload the page and try again." });
  }, [toast]);

  // Anonymous rows intentionally omit ownerUserId. Membership in this
  // authenticated owner-only list keeps the control working without putting
  // a stable identity key back into the public response.
  const owned = ownerStats?.items?.find((row) => row.slug === slug);
  const isOwner = Boolean(owned);
  // An owner sees these controls before choosing Remove, so the dialog is usually ready by then.
  useEffect(() => {
    if (isOwner) void loadRemoveDialog().catch(() => undefined);
  }, [isOwner]);
  if (!owned) return null;

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
      {compact ? <CommunityOwnerMenu sourceSlug={owned.sourceSlug} onRemove={openReview} /> : <Button
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
      </Button>}

      {dialogMounted ? (
        <CommunityRemoveDialog
          step={step}
          title={title}
          acknowledged={acknowledged}
          removing={removing}
          error={error}
          finalAcknowledgementRef={finalAcknowledgementRef}
          onClose={close}
          onContinue={continueToFinal}
          onBack={() => {
            setAcknowledged(false);
            setError(null);
            setStep("review");
          }}
          onAcknowledge={setAcknowledged}
          onRemove={removeFromCommunity}
          onUnavailable={dialogUnavailable}
        />
      ) : null}
    </>
  );
}
