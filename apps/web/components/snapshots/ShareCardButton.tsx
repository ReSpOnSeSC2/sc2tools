"use client";

import { useState } from "react";

// PNG export of the snapshot summary. Uses an offscreen <canvas>
// drawn directly (we deliberately avoid html-to-image / domtoimage
// to keep the bundle slim — Recharts uses SVG so we'd otherwise
// need to inline the entire DOM tree). The summary card is
// hand-composited: title + verdict pill + inflection point + URL.

export interface ShareCardButtonProps {
  gameId: string;
  verdictLabel: string;
  inflectionAt: string | null;
  cohortLabel: string;
  pageUrl?: string;
}

export function ShareCardButton({
  gameId,
  verdictLabel,
  inflectionAt,
  cohortLabel,
  pageUrl,
}: ShareCardButtonProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setErr(null);
    try {
      const dataUrl = renderShareCard({
        gameId,
        verdictLabel,
        inflectionAt,
        cohortLabel,
        pageUrl: pageUrl || (typeof window !== "undefined" ? window.location.href : ""),
      });
      triggerDownload(dataUrl, `snapshot-${gameId}.png`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't render the share card.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={[
          "inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-caption font-semibold text-text",
          "hover:bg-bg-subtle hover:border-border-strong disabled:opacity-50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        {busy ? "Rendering…" : "Export PNG"}
      </button>
      {err ? <span className="text-[11px] text-danger">{err}</span> : null}
    </div>
  );
}

function renderShareCard(opts: {
  gameId: string;
  verdictLabel: string;
  inflectionAt: string | null;
  cohortLabel: string;
  pageUrl: string;
}) {
  const w = 1200;
  const h = 630;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not supported.");
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#0b0d12");
  grad.addColorStop(1, "#11141b");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#7c8cff";
  ctx.font = "600 24px Inter, system-ui, sans-serif";
  ctx.fillText("SC2 TOOLS · Snapshot", 64, 96);
  ctx.fillStyle = "#e6e8ee";
  ctx.font = "700 56px Inter, system-ui, sans-serif";
  ctx.fillText(opts.verdictLabel, 64, 192);
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "500 24px Inter, system-ui, sans-serif";
  ctx.fillText(opts.cohortLabel, 64, 240);
  if (opts.inflectionAt) {
    ctx.fillStyle = "#fb923c";
    ctx.font = "500 32px Inter, system-ui, sans-serif";
    ctx.fillText(`Inflection point: ${opts.inflectionAt}`, 64, 360);
  }
  ctx.fillStyle = "#6b7280";
  ctx.font = "400 18px Inter, system-ui, sans-serif";
  ctx.fillText(opts.pageUrl.slice(0, 100), 64, h - 64);
  return canvas.toDataURL("image/png");
}

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
