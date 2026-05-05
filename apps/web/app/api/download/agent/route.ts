/**
 * GET /api/download/agent
 *
 * One-click installer download. 302-redirects to the latest
 * agent-v* GitHub release's `.exe` asset so users never have to know
 * the version number. A Download button anywhere on the site can
 * point at this URL — it just works.
 *
 * Optional query string:
 *   ?platform=windows  (default; the only supported platform today)
 *
 * Edge-cached for 10 min. Returns 503 if no release has been
 * published yet, which is rare in production but useful for the
 * window before the first release is tagged.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 600;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform") || "windows";

  // Reuse the metadata route's logic by hitting it through fetch.
  // Keeps the GitHub call shape in one place; the route is cached so
  // a redirect doesn't double-charge the rate limit.
  const metaUrl = new URL("/api/agent/version", url);
  metaUrl.searchParams.set("platform", platform);
  metaUrl.searchParams.set("channel", "stable");

  const res = await fetch(metaUrl.toString(), {
    next: { revalidate: 600 },
  });
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: "release_lookup_failed" },
      { status: 502 },
    );
  }
  const meta = (await res.json()) as {
    artifact?: { downloadUrl: string };
  };
  if (!meta.artifact?.downloadUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_release_published",
        message:
          "No installer has been tagged yet. Run from source meanwhile " +
          "or check back shortly.",
      },
      { status: 503 },
    );
  }

  return NextResponse.redirect(meta.artifact.downloadUrl, {
    status: 302,
    headers: {
      "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600",
    },
  });
}
