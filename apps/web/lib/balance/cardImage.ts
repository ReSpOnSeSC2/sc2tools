import { CARD_H, CARD_PAD, CARD_W, FONT_STACK, drawCardBackground } from "@/components/analyzer/arcade/ShareCard";
import { downloadBlob } from "@/lib/battleReportImage";
import { reportPng } from "@/lib/instant/reportCard";
import { shareReportPalette as palette } from "@/lib/shareReportPalette";

const KIND = { receipt: "BALANCE RECEIPT", permit: "WHINE PERMIT", verdict: "BALANCE COURT" } as const;
export type BalanceCardKind = keyof typeof KIND;
const WIDTH = CARD_W - 2 * CARD_PAD;

export async function downloadBalanceCard(kind: BalanceCardKind, title: string, lines: string[]) {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Image export is unavailable.");
  drawCardBackground(ctx, palette.replayAccent);
  ctx.textBaseline = "top";
  ctx.fillStyle = palette.replayAccent;
  ctx.font = `700 24px ${FONT_STACK}`;
  ctx.fillText(KIND[kind], CARD_PAD, 52);
  ctx.fillStyle = palette.weeklyText;
  ctx.font = `700 52px ${FONT_STACK}`;
  ctx.fillText(title, CARD_PAD, 102, WIDTH);
  ctx.fillStyle = palette.replayText;
  ctx.font = `500 29px ${FONT_STACK}`;
  lines.slice(0, 7).forEach((line, index) => ctx.fillText(line, CARD_PAD, 199 + index * 47, WIDTH));
  ctx.fillStyle = palette.replayAccent;
  ctx.font = `600 22px ${FONT_STACK}`;
  ctx.fillText("Data: SC2Pulse · sc2pulse.nephest.com/sc2/", CARD_PAD, 562, WIDTH);
  ctx.textAlign = "right";
  ctx.fillText("sc2tools.com/balance", CARD_W - CARD_PAD, 562);
  downloadBlob(await reportPng(canvas), `sc2tools-${kind}.png`);
}
