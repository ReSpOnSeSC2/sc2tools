import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { COMMUNITY_CACHE_TAG } from "@/lib/communityCache";
import { GUIDE_REVALIDATE_MAX_BODY_BYTES, GUIDE_REVALIDATE_SIGNATURE_HEADER, verifyGuideRevalidation } from "@/lib/guides/revalidateSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const reply = (status: number, error: string) => NextResponse.json({ error }, { status, headers });

/** The same raw-body HMAC protocol as guides, with an independent scope and
 * opt-in secret. Bound streaming reads too; Content-Length is not trusted. */
export async function POST(request: Request) {
  const secret = process.env.COMMUNITY_REVALIDATE_SECRET;
  if (!secret?.trim()) return reply(503, "not_configured");
  if (Number(request.headers.get("content-length")) > GUIDE_REVALIDATE_MAX_BODY_BYTES) return reply(413, "too_large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0, current = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (!reader) return;
        for (;;) {
          const chunk = await reader.read(); if (!current || chunk.done) return;
          bytes += chunk.value.byteLength;
          if (bytes > GUIDE_REVALIDATE_MAX_BODY_BYTES) throw new Error("too_large");
          chunks.push(chunk.value);
        }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("body_timeout")), 2_000); }),
    ]);
  } catch (error) {
    void reader?.cancel().catch(() => {});
    return reply(error instanceof Error && error.message === "too_large" ? 413 : 408,
      error instanceof Error && error.message === "too_large" ? "too_large" : "body_timeout");
  } finally { current = false; if (timer) clearTimeout(timer); }
  const raw = Buffer.concat(chunks).toString("utf8");
  const verdict = verifyGuideRevalidation(secret, request.headers.get(GUIDE_REVALIDATE_SIGNATURE_HEADER), raw, Date.now());
  if (!verdict.ok) return reply(401, verdict.reason);
  if (verdict.scope !== "community") return reply(400, "bad_scope");
  revalidateTag(COMMUNITY_CACHE_TAG);
  revalidatePath("/community", "layout");
  revalidatePath("/sitemap.xml");
  return NextResponse.json({ revalidated: true, tag: COMMUNITY_CACHE_TAG }, { headers });
}
