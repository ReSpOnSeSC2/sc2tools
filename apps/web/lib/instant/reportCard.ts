import { CARD_W, CARD_H, CARD_PAD, FONT_STACK, drawCardBackground, wrapText } from "@/components/analyzer/arcade/ShareCard";
import type { ReportCardModel } from "./reportSharing";

/** Fixed 1200×630 local canvas. Input is the identity-free aggregate projection. */
export function drawReportCard(canvas: HTMLCanvasElement, model: ReportCardModel): void {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("PNG previews are unavailable in this browser.");
  drawCardBackground(ctx, "#7DC8FF");
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 44px ${FONT_STACK}`;
  ctx.fillText("My StarCraft II replay report", CARD_PAD, 42);
  ctx.font = `500 30px ${FONT_STACK}`;
  ctx.fillStyle = "#e6edf3";
  if (model.totals) ctx.fillText(`${model.totals.games} games · ${model.totals.wins}W ${model.totals.losses}L`, CARD_PAD, 104);
  model.matchups.forEach((row, index) => drawMatchup(ctx, row, 170 + index * 74));
  if (model.opener) {
    ctx.fillStyle = "#b7c6d8";
    ctx.font = `600 22px ${FONT_STACK}`;
    ctx.fillText(`BEST OPENER · ${model.opener.games} GAMES`, CARD_PAD, 410);
    ctx.fillStyle = "#ffffff";
    ctx.font = `600 27px ${FONT_STACK}`;
    wrapText(ctx, model.opener.name, CARD_PAD, 445, model.macro ? 780 : 1080, 32, 2);
    ctx.font = `500 22px ${FONT_STACK}`;
    ctx.fillText(`${model.opener.wins}W ${model.opener.losses}L`, CARD_PAD, 516);
  }
  if (model.macro) {
    ctx.fillStyle = "#b7c6d8";
    ctx.font = `600 22px ${FONT_STACK}`;
    ctx.fillText("MACRO SCORE", 905, 410);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 48px ${FONT_STACK}`;
    ctx.fillText(`${model.macro.score}/100`, 905, 447);
    ctx.font = `400 18px ${FONT_STACK}`;
    ctx.fillText(`${model.macro.games} measured games`, 905, 510);
  }
  ctx.fillStyle = "#a9d6ff";
  ctx.font = `600 25px ${FONT_STACK}`;
  ctx.fillText("sc2tools.com/try — analyze yours free", CARD_PAD, 574);
}

function drawMatchup(ctx: CanvasRenderingContext2D, row: ReportCardModel["matchups"][number], y: number): void {
  ctx.fillStyle = "#e6edf3";
  ctx.font = `600 25px ${FONT_STACK}`;
  ctx.fillText(row.label, CARD_PAD, y);
  ctx.fillText(`${row.wins}W ${row.losses}L`, 950, y);
  const decided = row.wins + row.losses;
  ctx.fillStyle = "#394554";
  ctx.fillRect(190, y + 3, 700, 24);
  if (decided > 0) {
    ctx.fillStyle = "#80d9a4";
    ctx.fillRect(190, y + 3, 700 * row.wins / decided, 24);
  }
}

export function reportPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PNG creation took too long. Try again.")), 20_000);
    try {
      canvas.toBlob((blob) => {
        clearTimeout(timer);
        if (blob) resolve(blob); else reject(new Error("Could not create the PNG. Try again."));
      }, "image/png");
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
