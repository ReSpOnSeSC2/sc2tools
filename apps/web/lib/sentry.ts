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

let client: Promise<Sentry | null> | null = null;

/**
 * The initialized client SDK, or null when there is no DSN or a chunk fails.
 * The SDK and the request-URL scrubber load together and init runs before
 * anything can report, so no event is captured unscrubbed or before init.
 */
function clientSentry(): Promise<Sentry | null> {
  client ??= (async () => {
    if (!DSN) return null;
    try {
      // Dynamic import so missing dep doesn't crash builds.
      // @ts-ignore — no types when the package isn't installed
      const [mod, privacy] = await Promise.all([import("@sentry/nextjs"), import("./sentryPrivacy")]);
      const s = mod as unknown as Sentry;
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
      return s;
    } catch {
      return null;
    }
  })();
  return client;
}

export async function initClientSentry(): Promise<void> {
  await clientSentry();
}

/**
 * Report an error. Resolves to the Sentry event id, which a crash panel
 * shows so a user report can be matched to the event; null when Sentry
 * is off (no DSN) and the error only went to the console.
 */
export async function captureException(err: unknown): Promise<string | null> {
  const s = await clientSentry();
  if (s) {
    const eventId = s.captureException(err);
    return typeof eventId === "string" && eventId ? eventId : null;
  }
  if (typeof console !== "undefined") console.error(err);
  return null;
}
