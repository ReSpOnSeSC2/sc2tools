/**
 * Next.js server instrumentation hook. Initializes Sentry for the
 * Node.js/edge runtimes and forwards request errors (server components,
 * route handlers) that the client-side boundaries never see.
 *
 * Both hooks no-op unless NEXT_PUBLIC_SENTRY_DSN is set, mirroring
 * lib/sentry.ts — the app must keep working without a DSN.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

export async function register(): Promise<void> {
  if (!DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: DSN,
      tracesSampleRate: 0.1,
      environment: process.env.NEXT_PUBLIC_SC2TOOLS_ENV || "production",
    });
  } catch {
    // Missing/broken dep must never take the server down.
  }
}

export async function onRequestError(
  ...args: unknown[]
): Promise<void> {
  if (!DSN) return;
  try {
    const Sentry = await import("@sentry/nextjs");
    (
      Sentry.captureRequestError as unknown as (...a: unknown[]) => void
    )(...args);
  } catch {
    // ignore — error reporting must not throw
  }
}
