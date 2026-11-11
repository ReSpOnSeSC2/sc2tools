import { ImageResponse } from "next/og";
import { record } from "@/lib/reports";
import { fetchPublicStreamReport, type PublicStreamParams } from "@/lib/publicStreamReport";

export const dynamic = "force-dynamic";
export const alt = "Shared SC2 Tools stream report";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function StreamReportImage({ params }: PublicStreamParams) {
  const { player, id } = await params;
  const report = await fetchPublicStreamReport(player, id);
  return new ImageResponse(<div style={{ display: "flex", flexDirection: "column", gap: 36, width: "100%", height: "100%",
    background: "linear-gradient(135deg, #101e2c, #10151d)", padding: 76, color: "#edf6ff", fontFamily: "sans-serif" }}>
    <div style={{ fontSize: 30, color: "#79e5de" }}>SC2 TOOLS · STREAM REPORT</div>
    <div style={{ fontSize: 66, fontWeight: 750 }}>{report ? report.player : "Stream report unavailable"}</div>
    {report ? <div style={{ fontSize: 38 }}>{report.games} games · {record(report)} · {report.hours} h played</div> : null}
  </div>, { ...size, headers: { "Cache-Control": "private, no-store" } });
}
