import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { GUIDE_CACHE_TAG } from "@/lib/guides/api";
import {
  GUIDE_REVALIDATE_MAX_BODY_BYTES,
  GUIDE_REVALIDATE_SCOPE,
  GUIDE_REVALIDATE_SIGNATURE_HEADER,
  verifyGuideRevalidation,
} from "@/lib/guides/revalidateSignature";

/**
 * POST /api/revalidate-guides — on-demand purge after the API's nightly
 * guide_stats run, so fresh numbers don't wait out the 6 h data cache.
 *
 * Auth is the HMAC signature only (lib/guides/revalidateSignature.ts,
 * secret GUIDES_REVALIDATE_SECRET shared with the API): 503 while the
 * secret is unset, 401 for a bad signature or a ts outside ±5 min, 400
 * for a signed ping of another scope. On success it purges the "guides"
 * fetch-cache tag, everything under /guides and the sitemap. Public in
 * middleware, disallowed in robots (/api/). Never cached.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

function reply(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function tooLarge(request: Request, rawBody: string | null): boolean {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > GUIDE_REVALIDATE_MAX_BODY_BYTES) return true;
  return rawBody !== null && Buffer.byteLength(rawBody, "utf8") > GUIDE_REVALIDATE_MAX_BODY_BYTES;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.GUIDES_REVALIDATE_SECRET;
  if (!secret) return reply(503, { error: "not_configured" });
  if (tooLarge(request, null)) return reply(413, { error: "too_large" });
  const rawBody = await request.text();
  if (tooLarge(request, rawBody)) return reply(413, { error: "too_large" });

  const verdict = verifyGuideRevalidation(
    secret,
    request.headers.get(GUIDE_REVALIDATE_SIGNATURE_HEADER),
    rawBody,
    Date.now(),
  );
  if (!verdict.ok) return reply(401, { error: verdict.reason });
  if (verdict.scope !== GUIDE_REVALIDATE_SCOPE) return reply(400, { error: "bad_scope" });

  revalidateTag(GUIDE_CACHE_TAG);
  revalidatePath("/guides", "layout");
  revalidatePath("/sitemap.xml");
  return reply(200, { revalidated: true, tag: GUIDE_CACHE_TAG });
}
