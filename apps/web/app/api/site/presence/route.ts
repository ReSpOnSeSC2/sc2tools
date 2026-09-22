import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE_NAME = "sc2tools_site_visitor";
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{43}\.\d{13}\.[A-Za-z0-9_-]{43}$/;
const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(req: NextRequest) {
  // Only our own visible browser session may refresh this cookie. A cross-site
  // form or fetch must not manufacture visitors through the same-origin proxy.
  if (
    !hasSameOrigin(req) ||
    req.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return errorResponse("invalid_origin", 403);
  }
  if (req.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
    return errorResponse("json_required", 415);
  }

  try {
    const raw = await req.text();
    if (raw.length > 1_024) return errorResponse("invalid_presence_request", 400);
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("invalid_presence_request", 400);
    }
  } catch {
    return errorResponse("invalid_presence_request", 400);
  }

  const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
  const authorization = req.headers.get("authorization");
  if (authorization && /^Bearer [A-Za-z0-9._~-]+$/.test(authorization) && authorization.length <= 16_384) {
    // The API verifies Clerk's signature and derives identity itself.
    upstreamHeaders.authorization = authorization;
  }
  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  const visitorToken = cookie && TOKEN_PATTERN.test(cookie) ? cookie : undefined;
  const apiBase = (
    process.env.SC2TOOLS_API_BASE ||
    process.env.NEXT_PUBLIC_API_BASE ||
    "http://localhost:8080"
  ).replace(/\/+$/, "");

  let discardCookie = false;
  try {
    const forward = (token?: string) => fetch(`${apiBase}/v1/site/presence`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify({ visitorToken: token }),
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    let upstream = await forward(visitorToken);
    if (upstream.status === 400 && visitorToken) {
      const failure: unknown = await upstream.json();
      if (
        failure && typeof failure === "object" && "error" in failure &&
        failure.error && typeof failure.error === "object" && "code" in failure.error &&
        failure.error.code === "invalid_presence_token"
      ) {
        // A rotated signing key or an expired token must not strand a browser.
        discardCookie = true;
        upstream = await forward();
      }
    }
    if (!upstream.ok) return errorResponse("site_presence_unavailable", 503, discardCookie);
    const data: unknown = await upstream.json();
    if (
      !data || typeof data !== "object" ||
      !("visitorToken" in data) || typeof data.visitorToken !== "string" ||
      !TOKEN_PATTERN.test(data.visitorToken)
    ) {
      return errorResponse("site_presence_unavailable", 503, discardCookie);
    }

    const response = new NextResponse(null, { status: 204, headers: noStore });
    response.cookies.set(COOKIE_NAME, data.visitorToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: requestProtocol(req) === "https:",
      path: "/",
      maxAge: 180,
    });
    return response;
  } catch {
    return errorResponse("site_presence_unavailable", 503, discardCookie);
  }
}

function requestProtocol(req: NextRequest): string {
  // Hosting proxies terminate HTTPS before forwarding to Next. Never downgrade
  // an HTTPS request when determining its cookie or expected public origin.
  return req.headers.get("x-forwarded-proto") === "https" ? "https:" : req.nextUrl.protocol;
}

function hasSameOrigin(req: NextRequest): boolean {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  if (!host || !origin || !/^[a-z0-9.\-:\[\]]+$/i.test(host)) return false;
  try {
    // Next can normalize a loopback request URL to localhost even when the
    // browser used 127.0.0.1. Host is the incoming authority; forwarded-host
    // must not be allowed to override it for this origin check.
    return origin === new URL(`${requestProtocol(req)}//${host}`).origin;
  } catch {
    return false;
  }
}

function errorResponse(error: string, status: number, discardCookie = false) {
  const response = NextResponse.json({ error }, { status, headers: noStore });
  if (discardCookie) response.cookies.delete(COOKIE_NAME);
  return response;
}
