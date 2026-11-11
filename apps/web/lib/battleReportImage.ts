/**
 * battleReportImage — "Save as image" for a battle report: the headline,
 * the first paragraph and two snapshot charts on a 1200×630 card, drawn in
 * the browser with canvas and handed to the browser's normal download.
 *
 * Callers pass a report planned from a share-safe input
 * (lib/sharedGame.ts ``shareSafeReportInput``): the player and opponent
 * appear by race only and no rating is printed (ADR 0075). Snapshots use
 * recorded replay positions with army-value charts as the fallback.
 * It uses the same fixed-rule text the page shows.
 */

import { shareReportPalette } from "@/lib/shareReportPalette";
import {
  CARD_H,
  CARD_PAD,
  CARD_W,
  drawCardBackground,
  drawCardFooter,
  FONT_STACK,
  wrapText,
} from "@/components/analyzer/arcade/ShareCard";
import type { StatsEvent } from "@/components/analyzer/macro/MacroBreakdownPanel.types";
import type { SnapshotMoment } from "./battleReport/facts";
import type { BattleReport } from "./battleReport/plan";
import type { MapPlayback } from "./mapReplay";
import { snapshotColor, snapshotPositions } from "./battleReport/mapSnapshot";

const CONTENT_W = CARD_W - CARD_PAD * 2;
const ACCENT = { win: "rgb(40, 160, 107)", loss: "rgb(218, 65, 80)", neutral: "rgb(125, 200, 255)" } as const;
const TEXT = "rgb(230, 237, 243)";
const MUTED = "rgb(154, 163, 178)";
const PANEL = "rgb(22, 27, 34)";
const GRID = "rgb(48, 54, 61)";
const ME = "rgb(60, 224, 214)";
const OPP = "rgb(218, 65, 80)";
const PRIORITY = ["largest-swing", "largest-fight", "first-clash", "end", "middle", "opening"];

/**
 * The two moments an image shows: the turning point and the biggest fight
 * when recorded, otherwise the next best, in game-time order.
 */
export function reportImageMoments(report: BattleReport): SnapshotMoment[] {
  const moments = report.facts.moments;
  const ranked = moments.slice().sort((a, b) => rank(a.id) - rank(b.id) || a.time - b.time);
  return ranked.slice(0, 2).sort((a, b) => a.time - b.time);
}

function rank(id: string): number {
  const index = PRIORITY.indexOf(id);
  return index < 0 ? PRIORITY.length : index;
}

/** The first paragraph as plain sentences, time references kept. */
export function reportImageParagraph(report: BattleReport): string {
  return (report.paragraphs[0]?.sentences ?? []).map((sentence) => sentence.text).join(" ");
}

/** "sc2-battle-report-alcyone-le.png". */
export function battleReportImageFilename(report: BattleReport): string {
  const slug = (report.facts.map ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `sc2-battle-report${slug ? `-${slug}` : ""}.png`;
}

/**
 * Render the report card to a PNG Blob; null without a DOM or a 2D context.
 */
export async function renderBattleReportPng(
  report: BattleReport,
  samples: {
    mine?: readonly StatsEvent[] | null; opponent?: readonly StatsEvent[] | null; result?: string | null;
    playback?: MapPlayback | null; frames?: ReadonlyMap<number, MapPlayback>; myRace?: string | null; oppRace?: string | null;
  },
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const result = String(samples.result ?? "").toLowerCase();
  drawCardBackground(ctx, result === "victory" || result === "win" ? ACCENT.win : result === "defeat" || result === "loss" ? ACCENT.loss : ACCENT.neutral);
  ctx.textBaseline = "top";

  ctx.fillStyle = MUTED;
  ctx.font = `600 20px ${FONT_STACK}`;
  ctx.fillText("BATTLE REPORT · FROM THE REPLAY RECORD", CARD_PAD, 40);
  ctx.fillStyle = TEXT;
  ctx.font = `800 42px ${FONT_STACK}`;
  let y = wrapText(ctx, report.headline, CARD_PAD, 72, CONTENT_W, 50, 2) + 4;
  const dateline = [report.facts.map, report.facts.date, report.facts.length === null ? null : clock(report.facts.length)].filter(Boolean).join(" · ");
  if (dateline) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 20px ${FONT_STACK}`;
    ctx.fillText(dateline, CARD_PAD, y);
    y += 34;
  }
  ctx.fillStyle = TEXT;
  ctx.font = `400 23px ${FONT_STACK}`;
  wrapText(ctx, reportImageParagraph(report), CARD_PAD, y, CONTENT_W, 31, 5);

  const moments = reportImageMoments(report);
  const gap = 24, top = 392, height = 168;
  const width = moments.length > 1 ? (CONTENT_W - gap) / 2 : CONTENT_W;
  moments.forEach((moment, index) => {
    const x = CARD_PAD + index * (width + gap);
    const replay = samples.frames?.get(moment.time) ?? samples.playback;
    const frame = replay ? snapshotPositions(replay, moment.time, width, height - 40, moment.point) : null;
    if (frame) drawMapSnapshot(ctx, moment, frame, x, top, width, height, samples.myRace, samples.oppRace);
    else drawSnapshot(ctx, moment, x, top, width, height, samples, report.facts.length);
  });
  drawCardFooter(ctx, { brand: "SC2 Tools · Battle report", tag: "Written from the replay with fixed rules" });
  return await new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

function drawMapSnapshot(
  ctx: CanvasRenderingContext2D, moment: SnapshotMoment, frame: NonNullable<ReturnType<typeof snapshotPositions>>,
  x: number, y: number, width: number, height: number, myRace: string | null | undefined, oppRace: string | null | undefined,
) {
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = TEXT;
  ctx.font = `600 18px ${FONT_STACK}`;
  ctx.fillText(`${moment.caption} · ${clock(moment.time)}`, x + 14, y + 10);
  ctx.save();
  ctx.translate(x, y + 36);
  const { terrain, points, fight } = frame;
  ctx.fillStyle = GRID;
  ctx.fillRect(terrain.x, terrain.y, terrain.width, terrain.height);
  for (const point of points) {
    const color = snapshotColor(point.side === "me" ? myRace : oppRace, point.side);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (point.structure) ctx.rect(point.x - 2.5, point.y - 2.5, 5, 5);
    else ctx.arc(point.x, point.y, 1.9, 0, Math.PI * 2);
    if (point.side === "me") ctx.fill();
    else ctx.stroke();
  }
  if (fight) {
    ctx.strokeStyle = shareReportPalette.fight;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fight.x, fight.y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSnapshot(
  ctx: CanvasRenderingContext2D, moment: SnapshotMoment, x: number, y: number, width: number, height: number,
  samples: { mine?: readonly StatsEvent[] | null; opponent?: readonly StatsEvent[] | null }, duration: number | null,
) {
  ctx.fillStyle = PANEL;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = TEXT;
  ctx.font = `600 18px ${FONT_STACK}`;
  ctx.fillText(`${moment.caption} · ${clock(moment.time)}`, x + 14, y + 10);
  const from = Math.max(0, moment.time - 60);
  const until = Math.max(from + 1, Math.min(duration ?? moment.time + 60, moment.time + 60));
  const inRange = (rows: readonly StatsEvent[] | null | undefined) => (rows ?? [])
    .filter((row) => finite(row.time) && row.time >= from && row.time <= until && finite(row.army_value))
    .sort((a, b) => a.time - b.time);
  const mine = inRange(samples.mine), opponent = inRange(samples.opponent);
  const values = [...mine, ...opponent].map((row) => row.army_value as number);
  const chart = { left: x + 14, right: x + width - 14, top: y + 40, bottom: y + height - 14 };
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  line(ctx, chart.left, chart.bottom, chart.right, chart.bottom);
  if (!values.length) {
    ctx.fillStyle = MUTED;
    ctx.font = `400 16px ${FONT_STACK}`;
    ctx.fillText("No army-value samples near this moment", chart.left, chart.top + 30);
    return;
  }
  const maximum = Math.max(1, ...values);
  const px = (t: number) => chart.left + (t - from) / (until - from) * (chart.right - chart.left);
  const py = (v: number) => chart.bottom - v / maximum * (chart.bottom - chart.top);
  ctx.setLineDash?.([4, 4]);
  line(ctx, px(moment.time), chart.top, px(moment.time), chart.bottom);
  ctx.setLineDash?.([]);
  for (const [rows, color] of [[mine, ME], [opponent, OPP]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    rows.forEach((row, index) => {
      const gapped = index > 0 && row.time - rows[index - 1].time > 30;
      if (index === 0 || gapped) ctx.moveTo(px(row.time), py(row.army_value as number));
      else ctx.lineTo(px(row.time), py(row.army_value as number));
    });
    ctx.stroke();
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Hand a Blob to the browser's normal download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
