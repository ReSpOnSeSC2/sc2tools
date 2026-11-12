/**
 * Next.js server instrumentation hook. Initializes Sentry for the
 * Node.js/edge runtimes and forwards request errors (server components,
 * route handlers) that the client-side boundaries never see.
 *
 * Both hooks no-op unless NEXT_PUBLIC_SENTRY_DSN is set, mirroring
 * lib/sentry.ts — the app must keep working without a DSN.
 */

import { streamViewerTelemetryPath } from "@/lib/streamViewerRoute";

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

function isStreamViewerUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return streamViewerTelemetryPath(new URL(value.replace(/^\S+\s+/, ""), "https://sc2tools.com").pathname) !== null; }
  catch { return false; }
}

export async function register(): Promise<void> {
  if (!DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: DSN,
      tracesSampleRate: 0.1,
      environment: process.env.NEXT_PUBLIC_SC2TOOLS_ENV || "production",
      beforeSend: event => isStreamViewerUrl(event.request?.url) ? null : event,
      beforeSendTransaction: event => isStreamViewerUrl(event.request?.url) || isStreamViewerUrl(event.transaction) ? null : event,
    });
  } catch {
    // Missing/broken dep must never take the server down.
  }
}

export async function onRequestError(
  ...args: unknown[]
): Promise<void> {
  const request = args[1] as { path?: unknown } | undefined;
  if (!DSN || isStreamViewerUrl(request?.path)) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    (
      Sentry.captureRequestError as unknown as (...a: unknown[]) => void
    )(...args);
  } catch {
    // ignore — error reporting must not throw
  }
}
