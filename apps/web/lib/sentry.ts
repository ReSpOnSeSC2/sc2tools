/**
 * Sentry wiring. `@sentry/nextjs` is installed; capture activates only
 * when NEXT_PUBLIC_SENTRY_DSN is set (Vercel env), so DSN-less deploys
 * and local dev stay no-op. Client init happens in
 * instrumentation-client.ts, server init + request-error forwarding in
 * instrumentation.ts, render-crash capture in components/ui/SectionBoundary
 * plus app/error.tsx and app/global-error.tsx.
 *
 * The dynamic import is kept deliberately: the SDK chunk is only
 * fetched when a DSN exists, and a missing/broken dep can never crash
 * the app.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

type Sentry = {
  init: (opts: Record<string, unknown>) => void;
  /** Returns the id of the event it recorded. */
  captureException: (err: unknown) => string;
};

let cached: Sentry | null = null;

async function getSentry(): Promise<Sentry | null> {
  if (cached) return cached;
  if (!DSN) return null;
  try {
    // Dynamic import so missing dep doesn't crash builds.
    // @ts-ignore — no types when the package isn't installed
    const mod = await import("@sentry/nextjs");
    cached = mod as unknown as Sentry;
    return cached;
  } catch {
    return null;
  }
}

export async function initClientSentry(): Promise<void> {
  const s = await getSentry();
  if (!s) return;
  // Request URLs lose typed search text and credentials first; without the
  // scrubber, nothing is reported.
  const privacy = await import("./sentryPrivacy").catch(() => null);
  if (!privacy) return;
  s.init({
    dsn: DSN,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 0.0,
    replaysSessionSampleRate: 0.0,
    environment: process.env.NEXT_PUBLIC_SC2TOOLS_ENV || "production",
    beforeBreadcrumb: privacy.scrubBreadcrumb,
    beforeSendSpan: privacy.scrubSpan,
    beforeSendTransaction: privacy.scrubTransaction,
  });
}

/**
 * Report an error. Resolves to the Sentry event id, which a crash panel
 * shows so a user report can be matched to the event; null when Sentry
 * is off (no DSN) and the error only went to the console.
 */
export async function captureException(err: unknown): Promise<string | null> {
  const s = await getSentry();
  if (s) {
    const eventId = s.captureException(err);
    return typeof eventId === "string" && eventId ? eventId : null;
  }
  if (typeof console !== "undefined") console.error(err);
  return null;
}
