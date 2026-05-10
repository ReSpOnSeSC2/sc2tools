"use client";

/**
 * ShareCard — client-side <canvas> 1200×630 PNG generator.
 *
 * Pure presentation: caller passes a title + body text + optional
 * accent color. We render to a hidden canvas, export to a blob, and
 * either invoke the Web Share API on mobile or copy the data URL to
 * the clipboard on desktop. No third-party libs.
 */

export interface ShareCardInput {
  title: string;
  /** 1–4 lines of body text. Each line wraps to ~38 chars at 32px. */
  lines: string[];
  /** "wins" | "neutral" | "loss" — drives the accent. */
  tone?: "wins" | "neutral" | "loss";
  /** Bottom-left tag, e.g. "Closer's Eye · Daily Drop". */
  tag?: string;
}

const W = 1200;
const H = 630;

export async function shareCard(input: ShareCardInput): Promise<{ shared: boolean }> {
  if (typeof document === "undefined") return { shared: false };
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { shared: false };

  const accent =
    input.tone === "wins"
      ? "#28A06B"
      : input.tone === "loss"
        ? "#DA4150"
        : "#7DC8FF";

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#0e1218");
  grad.addColorStop(1, "#161b22");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Accent stripe
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 12, H);

  // Title
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 64px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textBaseline = "top";
  wrapText(ctx, input.title, 60, 80, W - 120, 70, 2);

  // Body
  ctx.fillStyle = "#c9d1d9";
  ctx.font = "500 36px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  let y = 250;
  for (const line of input.lines.slice(0, 4)) {
    wrapText(ctx, line, 60, y, W - 120, 44, 2);
    y += 80;
  }

  // Footer brand
  ctx.fillStyle = "#7DC8FF";
  ctx.font = "600 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillText("SC2 Tools · Arcade", 60, H - 70);

  if (input.tag) {
    ctx.fillStyle = "#8a96a8";
    ctx.font = "400 22px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillText(input.tag, 60, H - 40);
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return { shared: false };

  const file = new File([blob], "arcade-share.png", { type: "image/png" });

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      const shareData: ShareData = {
        title: input.title,
        text: input.lines.join("\n"),
        files: [file],
      };
      // Some browsers (Safari iOS) require canShare gating.
      if (
        typeof (navigator as Navigator & { canShare?: (data: ShareData) => boolean }).canShare !== "function" ||
        (navigator as Navigator & { canShare: (data: ShareData) => boolean }).canShare(shareData)
      ) {
        await navigator.share(shareData);
        return { shared: true };
      }
    } catch {
      // user cancelled — fall through to clipboard
    }
  }

  // Clipboard fallback. Copies the PNG (modern browsers) plus the text
  // body as a fallback for clipboards without image support.
  try {
    if (typeof ClipboardItem !== "undefined" && typeof navigator?.clipboard?.write === "function") {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return { shared: true };
    }
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(`${input.title}\n${input.lines.join("\n")}`);
      return { shared: true };
    }
  } catch {
    // ignore
  }

  // Last-ditch: download the PNG so the user can attach it manually.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "arcade-share.png";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
  return { shared: true };
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/);
  let line = "";
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      line = word;
      lines += 1;
      if (lines >= maxLines) {
        ctx.fillText(`${line.slice(0, Math.max(0, line.length - 3))}…`, x, y + lines * lineHeight);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineHeight);
}
