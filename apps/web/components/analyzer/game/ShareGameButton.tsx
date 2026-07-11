"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import {
  battleCardFilename,
  battleCardShareText,
  renderBattleCardPng,
} from "@/lib/battleCard";
import { deliverShareCard } from "@/components/analyzer/arcade/ShareCard";
import type { GameSummary } from "./types";

/**
 * ShareGameButton — an unobtrusive "Share this game" control for the
 * per-game deep-dive header. Renders the game's 1200×630 battle card and
 * hands it to the shared delivery pipeline (Web Share → clipboard →
 * download), with a toast for feedback when a provider is present.
 *
 * Additive only: safe to drop into the header without a ToastProvider
 * (the toast just no-ops). Meets the 44px touch-target bar and is fully
 * labelled for assistive tech.
 */
export function ShareGameButton({
  game,
  className,
}: {
  game: GameSummary;
  className?: string;
}) {
  const toastCtx = useToastOptional();
  const toast = toastCtx?.toast;
  const [busy, setBusy] = useState(false);

  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await renderBattleCardPng(game);
      if (!blob) {
        toast?.error("Couldn't render the battle card");
        return;
      }
      const { shared } = await deliverShareCard({
        blob,
        title: "SC2 Battle Card",
        text: battleCardShareText(game),
        filename: battleCardFilename(game),
      });
      toast?.success(shared ? "Battle card shared" : "Battle card saved");
    } catch {
      toast?.error("Share failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="secondary"
      size="md"
      onClick={onShare}
      loading={busy}
      className={className}
      aria-label="Share this game as an image"
      iconLeft={<Share2 className="h-4 w-4" aria-hidden />}
    >
      {busy ? "Preparing…" : "Share this game"}
    </Button>
  );
}
