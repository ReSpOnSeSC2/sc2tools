"use client";

/**
 * ShareCard — client-side <canvas> 1200×630 PNG generator.
 *
 * Layout (top → bottom):
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ ▌ Mode title                                          │
 *   │   QUESTION                                            │
 *   │   The question prompt the user just answered.         │
 *   │   ──────────────                ✅ Correct / ❌ Missed │
 *   │   ANSWER                                              │
 *   │   Review line 1                                       │
 *   │   Review line 2                                       │
 *   │   ...                                                 │
 *   │   SC2 Tools · Arcade        Arcade · Daily Drop       │
 *   └────────────────────────────────────────────────────────┘
 *
 * Caller passes the mode title, the question prompt, an outcome, and
 * the multi-line answer/review. The card auto-fits each section, so
 * modes with terse reveals (one line) and modes with detail tables
 * (4–6 lines) both look right. No third-party libs.
 */

import type { CardShareMethod } from "@/lib/analytics/shareEvents";

export interface ShareCardInput {
  title: string;
  /** The question prompt as plain text. Optional for legacy callers. */
  question?: string;
  /** Outcome chip — drives both the accent stripe and the inline pill. */
  outcome?: "correct" | "partial" | "wrong";
  /** 1–6 lines of review/answer body text. */
  lines: string[];
  /**
   * Tone override — only honored when `outcome` is absent. New callers
   * should pass `outcome` so the stripe colour and the chip stay in sync.
   */
  tone?: "wins" | "neutral" | "loss";
  /** Bottom-right tag, e.g. "Closer's Eye · Daily Drop". */
  tag?: string;
}

/** Canvas dimensions — the standard 1200×630 OpenGraph share size. */
export const CARD_W = 1200;
export const CARD_H = 630;
/** Horizontal padding shared by every card layout. */
export const CARD_PAD = 60;

const W = CARD_W;
const H = CARD_H;
const PAD_L = CARD_PAD;
const PAD_R = CARD_PAD;
const CONTENT_W = W - PAD_L - PAD_R;

export const FONT_STACK = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

/**
 * Link-back for every share payload. The share TEXT carries the full
 * URL (so pasted shares are clickable) and the card itself carries the
 * short label as a watermark (so screenshots still say where they came
 * from).
 *
 * No page lives at this address yet: next.config.mjs redirects it
 * (shareCardRedirects), and a test keeps that rule on this exact path.
 * Cards already posted carry it, so change the redirect, not the address.
 */
export const SHARE_LINK_URL = "https://sc2tools.com/arcade";
export const SHARE_LINK_LABEL = "sc2tools.com/arcade";

/**
 * Outcome of a share attempt. `method` is the path that delivered the
 * card, so callers can count shares by path. It is null, with `shared`
 * false, when nothing was delivered: the card could not be rendered, or
 * the player dismissed the share sheet.
 */
export interface ShareDelivery {
  shared: boolean;
  method: CardShareMethod | null;
}

const NOT_SHARED: ShareDelivery = { shared: false, method: null };

/**
 * Callers must pass text that is safe to publish: opponents by neutral
 * label or race only, never by name, id or exact rating
 * (lib/sharePrivacy.ts). Everything in `input` is drawn and sent as is.
 */
export async function shareCard(input: ShareCardInput): Promise<ShareDelivery> {
  if (typeof document === "undefined") return NOT_SHARED;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return NOT_SHARED;

  const accent = pickAccent(input);
  drawCardBackground(ctx, accent);

  // Title
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 56px ${FONT_STACK}`;
  ctx.textBaseline = "top";
  const titleBottom = wrapText(ctx, input.title, PAD_L, 56, CONTENT_W, 64, 1);

  let y = titleBottom + 28;

  // Question section
  if (input.question) {
    ctx.fillStyle = "#7a8597";
    ctx.font = `700 18px ${FONT_STACK}`;
    ctx.fillText("QUESTION", PAD_L, y);
    y += 26;

    ctx.fillStyle = "#e6edf3";
    ctx.font = `500 26px ${FONT_STACK}`;
    y = wrapText(ctx, input.question, PAD_L, y, CONTENT_W, 34, 2);
    y += 18;
  }

  // Outcome chip — sits on its own horizontal rule.
  if (input.outcome) {
    const chip = chipLabel(input.outcome);
    ctx.fillStyle = "#272d36";
    ctx.fillRect(PAD_L, y + 9, CONTENT_W, 1);

    ctx.fillStyle = accent;
    ctx.font = `700 20px ${FONT_STACK}`;
    const chipWidth = ctx.measureText(chip).width + 28;
    const chipX = W - PAD_R - chipWidth;
    roundRect(ctx, chipX, y - 6, chipWidth, 34, 17);
    ctx.fillStyle = "#0e1218";
    ctx.fillText(chip, chipX + 14, y + 1);
    y += 44;
  }

  // Answer section
  ctx.fillStyle = "#7a8597";
  ctx.font = `700 18px ${FONT_STACK}`;
  ctx.fillText("ANSWER", PAD_L, y);
  y += 26;

  // Body lines — auto-sized so a 1-line reveal looks generous and a
  // 6-line reveal still fits before the footer.
  const lines = input.lines.slice(0, 6);
  const footerTop = H - 70;
  const available = footerTop - y - 8;
  const fontSize = lines.length <= 2 ? 28 : lines.length <= 4 ? 24 : 20;
  const lineH = Math.max(fontSize + 8, Math.floor(available / Math.max(lines.length, 1)));
  ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
  ctx.fillStyle = "#c9d1d9";
  for (const line of lines) {
    const nextY = wrapText(ctx, line, PAD_L, y, CONTENT_W, fontSize + 6, 2);
    y = Math.max(nextY, y + lineH);
    if (y >= footerTop - 4) break;
  }

  drawCardFooter(ctx, { tag: input.tag });

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return NOT_SHARED;

  const shareText = [
    input.title,
    input.question ? `\nQ: ${input.question}` : "",
    input.outcome ? `\n${chipLabel(input.outcome)}` : "",
    input.lines.length ? `\n${input.lines.join("\n")}` : "",
  ]
    .join("")
    .trim();

  return deliverShareCard({
    blob,
    title: input.title,
    // Link-back: every text payload ends with the sc2tools.com URL so
    // shares posted to Discord/Twitter/etc. point back at the site.
    text: `${shareText}\n\n${SHARE_LINK_URL}`,
    filename: "arcade-share.png",
  });
}

/* ============================================================
 * Shared canvas + delivery helpers — reused by SeasonRecap's
 * card renderer (and any future share surface). Keep these free
 * of arcade-round specifics.
 * ============================================================ */

/** Paint the standard dark gradient background + left accent stripe. */
export function drawCardBackground(
  ctx: CanvasRenderingContext2D,
  accent: string,
): void {
  const grad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  grad.addColorStop(0, "#0e1218");
  grad.addColorStop(1, "#161b22");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 12, CARD_H);
}

/**
 * Footer: brand (left), the sc2tools.com watermark right after it, and
 * an optional context tag (right). The watermark is the on-image
 * link-back — screenshots and re-uploads keep pointing home even when
 * the share text gets stripped.
 */
export function drawCardFooter(
  ctx: CanvasRenderingContext2D,
  opts: { brand?: string; tag?: string } = {},
): void {
  const brand = opts.brand ?? "SC2 Tools · Arcade";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#7DC8FF";
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillText(brand, CARD_PAD, CARD_H - 50);
  const brandW = ctx.measureText(brand).width;

  ctx.fillStyle = "#8a96a8";
  ctx.font = `400 20px ${FONT_STACK}`;
  ctx.fillText(SHARE_LINK_LABEL, CARD_PAD + brandW + 18, CARD_H - 46);

  if (opts.tag) {
    ctx.fillStyle = "#8a96a8";
    ctx.font = `400 20px ${FONT_STACK}`;
    const w = ctx.measureText(opts.tag).width;
    ctx.fillText(opts.tag, CARD_W - CARD_PAD - w, CARD_H - 46);
  }
}

export interface DeliverShareInput {
  blob: Blob;
  title: string;
  /** Plain-text payload. Callers must already include the link-back. */
  text: string;
  filename?: string;
}

/** The Web Share API rejects with an AbortError when the sheet is dismissed. */
function isShareDismissal(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * What to tell the player once a card has been delivered.
 *
 * Example: `shareOutcome("Recap", "download")` → "Recap saved".
 */
export function shareOutcome(what: string, method: CardShareMethod): string {
  if (method === "web_share") return `${what} shared`;
  if (method === "download") return `${what} saved`;
  return `${what} copied`;
}

/**
 * Delivery pipeline shared by every share surface:
 * Web Share (with PNG attached) → clipboard PNG → clipboard text →
 * download. Resolves { shared: true, method } as soon as one path lands,
 * and { shared: false } when the player dismisses the share sheet.
 */
export async function deliverShareCard({
  blob,
  title,
  text,
  filename = "arcade-share.png",
}: DeliverShareInput): Promise<ShareDelivery> {
  const file = new File([blob], filename, { type: "image/png" });

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const shareData: ShareData = {
        title,
        text,
        files: [file],
      };
      if (
        typeof (navigator as Navigator & { canShare?: (data: ShareData) => boolean }).canShare !== "function" ||
        (navigator as Navigator & { canShare: (data: ShareData) => boolean }).canShare(shareData)
      ) {
        await navigator.share(shareData);
        return { shared: true, method: "web_share" };
      }
    } catch (error) {
      // Dismissing the share sheet is a choice, not a failure: stop here
      // rather than copy or download a card the player just declined to
      // send. Any other error (no permission, files unsupported) falls
      // through to the next path.
      if (isShareDismissal(error)) return NOT_SHARED;
    }
  }

  // Clipboard fallback. Copies the PNG (modern browsers) plus the text
  // body as a fallback for clipboards without image support.
  try {
    if (typeof ClipboardItem !== "undefined" && typeof navigator?.clipboard?.write === "function") {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return { shared: true, method: "clipboard_image" };
    }
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { shared: true, method: "clipboard_text" };
    }
  } catch {
    // ignore
  }

  // Last-ditch: download the PNG so the user can attach it manually.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
  return { shared: true, method: "download" };
}

function pickAccent(input: ShareCardInput): string {
  const tone =
    input.outcome === "correct"
      ? "wins"
      : input.outcome === "wrong"
        ? "loss"
        : input.outcome === "partial"
          ? "neutral"
          : input.tone || "neutral";
  return tone === "wins" ? "#28A06B" : tone === "loss" ? "#DA4150" : "#7DC8FF";
}

function chipLabel(outcome: "correct" | "partial" | "wrong"): string {
  if (outcome === "correct") return "✅ Correct";
  if (outcome === "partial") return "◐ Partial";
  return "❌ Missed";
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * Word-wrap helper. Renders up to `maxLines` lines starting at
 * (x, y), truncating with an ellipsis if the text overflows. Returns
 * the y-coordinate immediately below the last rendered line so the
 * caller can stack the next section right under it.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
): number {
  const words = String(text || "").split(/\s+/);
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      line = word;
      lines += 1;
      if (lines >= maxLines) {
        ctx.fillText(
          `${line.slice(0, Math.max(0, line.length - 3))}…`,
          x,
          y + lines * lineHeight,
        );
        return y + (lines + 1) * lineHeight;
      }
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, y + lines * lineHeight);
    return y + (lines + 1) * lineHeight;
  }
  return y;
}
