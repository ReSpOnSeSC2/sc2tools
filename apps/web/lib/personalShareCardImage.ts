import {
  CARD_H, CARD_PAD, CARD_PALETTE, CARD_W, FONT_STACK, deliverShareCard, drawCardBackground, drawCardFooter, shareOutcome,
} from "@/components/analyzer/arcade/ShareCard";
import type { PersonalShareCard } from "@/lib/personalShareCards";
import { shareReportPalette } from "@/lib/shareReportPalette";

const SITE = "sc2tools.com";

export async function sharePersonalCard(card: PersonalShareCard) {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  drawCardBackground(ctx, CARD_PALETTE.accent);
  ctx.textBaseline = "top";
  ctx.fillStyle = CARD_PALETTE.ink;
  ctx.font = `750 62px ${FONT_STACK}`;
  ctx.fillText(card.title, CARD_PAD, 54);
  ctx.fillStyle = shareReportPalette.weeklyMuted;
  ctx.font = `500 28px ${FONT_STACK}`;
  if (card.kind === "practice_grade") ctx.fillText(card.subtitle, CARD_PAD, 136, CARD_W - 2 * CARD_PAD);
  else ctx.fillText(card.subtitle, CARD_PAD, 136);

  const gap = 20;
  const width = (CARD_W - 2 * CARD_PAD - gap) / 2;
  card.stats.forEach(({ label, value }, index) => {
    const x = CARD_PAD + (index % 2) * (width + gap);
    const y = 204 + Math.floor(index / 2) * 162;
    const rowWidth = index === card.stats.length - 1 && index % 2 === 0 ? width * 2 + gap : width;
    ctx.fillStyle = shareReportPalette.weeklyTile;
    ctx.fillRect(x, y, rowWidth, 142);
    ctx.fillStyle = shareReportPalette.weeklyMuted;
    ctx.font = `600 24px ${FONT_STACK}`;
    ctx.fillText(label, x + 22, y + 22);
    ctx.fillStyle = CARD_PALETTE.ink;
    ctx.font = `750 48px ${FONT_STACK}`;
    ctx.fillText(value, x + 22, y + 62);
  });
  const link = `${SITE}${card.path ?? ""}`;
  drawCardFooter(ctx, { brand: "SC2 Tools", linkLabel: link });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG unavailable");
  const lines = card.stats.map(({ label, value }) => `${label}: ${value}`);
  const { shared, method } = await deliverShareCard({
    blob,
    title: card.title,
    text: [card.title, card.subtitle, ...lines, "", `https://${link}`].join("\n"),
    filename: `sc2tools-${card.kind.replaceAll("_", "-")}.png`,
  });
  return shared && method ? { method, feedback: shareOutcome(card.title, method) } : null;
}
