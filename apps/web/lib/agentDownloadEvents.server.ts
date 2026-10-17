import { randomUUID } from "node:crypto";

const DEFAULT_API_BASE = "http://localhost:8080";
const FORWARD_TIMEOUT_MS = 2_500;
const MAX_DELIVERY_ATTEMPTS = 2;

export type AgentDownloadEventPayload = {
  platform: string;
  version?: string;
  channel?: string;
};

type RequestWithHeaders = {
  headers: Headers;
};

/**
 * Persist an installer download event through the cloud API.
 *
 * This runs inside a Next.js route rather than in the browser so download
 * tracking does not depend on sendBeacon support, privacy extensions, or a
 * page remaining alive after the installer navigation starts. Failures are
 * retried once for transient errors, then logged and returned to the caller,
 * but never prevent the installer itself from being served. Both attempts
 * carry one download ID so an uncertain first response cannot count twice.
 */
export async function forwardAgentDownloadEvent(
  req: RequestWithHeaders,
  payload: AgentDownloadEventPayload,
): Promise<boolean> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  copyHeader(req.headers, headers, "user-agent");
  copyHeader(req.headers, headers, "referer");
  copyHeader(req.headers, headers, "x-forwarded-for");

  const country =
    req.headers.get("x-vercel-ip-country") ||
    req.headers.get("cf-ipcountry") ||
    req.headers.get("x-country-code");
  if (country) headers["x-geo-country"] = country;

  const body = JSON.stringify({
    downloadId: randomUUID(),
    platform: typeof payload.platform === "string" ? payload.platform : "",
    version: typeof payload.version === "string" ? payload.version : "",
    channel: typeof payload.channel === "string" ? payload.channel : "stable",
  });

  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    const lastAttempt = attempt === MAX_DELIVERY_ATTEMPTS - 1;
    try {
      const res = await fetch(`${apiBase()}/v1/agent/download-event`, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
      if (res.ok) return true;
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (lastAttempt || !retryable) {
        console.error(
          `[agent-download-event] forward failed with ${res.status}`,
        );
        return false;
      }
    } catch (err) {
      if (!lastAttempt) continue;
      console.error("[agent-download-event] forward failed", err);
      return false;
    }
  }
  return false;
}

function apiBase(): string {
  return (
    process.env.SC2TOOLS_API_BASE ||
    process.env.NEXT_PUBLIC_API_BASE ||
    DEFAULT_API_BASE
  ).replace(/\/+$/, "");
}

function copyHeader(
  source: Headers,
  target: Record<string, string>,
  name: string,
): void {
  const value = source.get(name);
  if (value) target[name] = value;
}
