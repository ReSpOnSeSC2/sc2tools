import { shareReportPalette } from "@/lib/shareReportPalette";
import {
  CARD_H, CARD_PAD, CARD_W, deliverShareCard, drawCardBackground, drawCardFooter, FONT_STACK, shareOutcome,
} from "@/components/analyzer/arcade/ShareCard";
import { plural, record, weekLabel, type WeeklyReport } from "./reports";

/** The public card uses aggregate facts without account names, ratings, builds or opponents. */
export function weeklyReportShareCopy(report: WeeklyReport) {
  const totals = report.totals;
  const stats = [
    { label: "Games", value: String(totals.games) },
    { label: "Wins–losses", value: record(totals) },
    { label: "Hours played", value: String(totals.hours) },
  ];
  const previous = `Previous week: ${plural(totals.previous.games, "game")} · ${record(totals.previous)} · ${totals.previous.hours} h`;
  const matchups = report.matchups.filter((row) => /^[PTZR?]v[PTZR?]$/.test(row.matchup))
    .slice(0, 4).map((row) => `${row.matchup} ${record(row)}`).join("  ·  ");
  return { label: weekLabel(report.week), stats, previous, matchups };
}

export async function shareWeeklyReport(report: WeeklyReport): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unavailable");
  const copy = weeklyReportShareCopy(report);
  drawCardBackground(ctx, shareReportPalette.weeklyAccent);
  ctx.textBaseline = "top";
  ctx.fillStyle = shareReportPalette.weeklyMuted;
  ctx.font = `600 26px ${FONT_STACK}`;
  ctx.fillText("WEEKLY REPORT", CARD_PAD, 54);
  ctx.fillStyle = shareReportPalette.weeklyText;
  ctx.font = `750 62px ${FONT_STACK}`;
  ctx.fillText(copy.label, CARD_PAD, 100);

  const width = (CARD_W - CARD_PAD * 2 - 48) / 3;
  copy.stats.forEach(({ label, value }, index) => {
    const x = CARD_PAD + index * (width + 24);
    ctx.fillStyle = shareReportPalette.weeklyTile;
    ctx.fillRect(x, 210, width, 150);
    ctx.fillStyle = shareReportPalette.weeklyMuted;
    ctx.font = `600 23px ${FONT_STACK}`;
    ctx.fillText(label, x + 24, 232);
    ctx.fillStyle = shareReportPalette.weeklyText;
    ctx.font = `750 60px ${FONT_STACK}`;
    ctx.fillText(value, x + 24, 275);
  });
  ctx.fillStyle = shareReportPalette.weeklyDetails;
  ctx.font = `600 26px ${FONT_STACK}`;
  ctx.fillText(copy.previous, CARD_PAD, 412);
  if (copy.matchups) ctx.fillText(copy.matchups, CARD_PAD, 465);
  drawCardFooter(ctx, { brand: "SC2 Tools", tag: "Weekly report" });

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("png_unavailable");
  const title = `SC2 Tools weekly report · ${copy.label}`;
  const text = [title, `${plural(report.totals.games, "game")} · ${record(report.totals)} · ${report.totals.hours} h`, copy.previous, copy.matchups]
    .filter(Boolean).join("\n");
  const { method } = await deliverShareCard({ blob, title, text, filename: `sc2tools-weekly-${report.week}.png` });
  return method ? shareOutcome("Weekly report", method) : null;
}
