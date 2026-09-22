import { NextResponse } from "next/server";
import { parseSiteStats } from "@/lib/siteStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET() {
  const apiBase = (
    process.env.SC2TOOLS_API_BASE ||
    process.env.NEXT_PUBLIC_API_BASE ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");

  try {
    const upstream = await fetch(`${apiBase}/v1/site/stats`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!upstream.ok) throw new Error("Statistics unavailable");
    return NextResponse.json(parseSiteStats(await upstream.json()), { headers });
  } catch {
    return NextResponse.json(
      { error: "site_stats_unavailable" },
      { status: 503, headers },
    );
  }
}
