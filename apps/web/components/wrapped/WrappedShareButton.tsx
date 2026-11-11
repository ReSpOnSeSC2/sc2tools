"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import {
  CARD_H, CARD_PAD, CARD_PALETTE, CARD_W, deliverShareCard, drawCardBackground,
  drawCardFooter, FONT_STACK, shareOutcome,
} from "@/components/analyzer/arcade/ShareCard";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { recapCount, wrappedShareText, YEAR_RECAP_URL, type WrappedCard } from "@/lib/career/wrappedCard";
import { formatNumber } from "@/lib/i18n/format";

function cardStats(card: WrappedCard): Array<[string, string]> {
  const stats: Array<[string, string]> = [
    ["Ladder games", formatNumber(card.games)],
    ["Record", `${recapCount(card.wins, "win")} · ${recapCount(card.losses, "loss", "losses")}`],
  ];
  if (card.minutes !== null) {
    const time = card.minutes < 60 ? `${card.minutes} min` : `${(card.minutes / 60).toFixed(1)} hours`;
    stats.push(["Time played", time]);
  }
  if (card.longestWinStreak >= 2) stats.push(["Best streak", `${card.longestWinStreak} wins`]);
  return stats;
}

/** The canvas has access only to the aggregate card projection. */
export function renderWrappedPng(card: WrappedCard): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  drawCardBackground(context, CARD_PALETTE.accent);
  context.textBaseline = "top";
  context.fillStyle = CARD_PALETTE.ink;
  context.font = `700 54px ${FONT_STACK}`;
  context.fillText(`My ${card.year} in StarCraft II`, CARD_PAD, 60);
  cardStats(card).forEach(([label, value], index) => {
    const y = 178 + index * 88;
    context.fillStyle = CARD_PALETTE.muted;
    context.font = `500 25px ${FONT_STACK}`;
    context.fillText(label, CARD_PAD, y + 8);
    context.fillStyle = CARD_PALETTE.ink;
    context.font = `700 40px ${FONT_STACK}`;
    context.fillText(value, CARD_PAD + 260, y);
  });
  drawCardFooter(context, { brand: "SC2 Tools", linkLabel: YEAR_RECAP_URL.replace(/^https:\/\//, "") });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function WrappedShareButton({ card }: { card: WrappedCard }) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function share() {
    setBusy(true);
    try {
      const blob = await renderWrappedPng(card);
      if (!blob) throw new Error("Card image unavailable");
      const delivery = await deliverShareCard({
        blob,
        title: `My ${card.year} in StarCraft II`,
        text: wrappedShareText(card),
        filename: `starcraft-ii-${card.year}.png`,
      });
      if (delivery.shared && delivery.method) toast.success(shareOutcome("Recap", delivery.method));
    } catch {
      toast.error("Couldn’t prepare the recap card. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <Button variant="primary" className="min-h-11" onClick={share} disabled={busy}
    iconLeft={<Share2 className="size-4" aria-hidden />}>{busy ? "Preparing…" : "Share card"}</Button>;
}
