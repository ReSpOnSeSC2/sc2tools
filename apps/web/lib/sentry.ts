/**
 * Optional Sentry wiring. The `@sentry/nextjs` package is NOT a hard
 * dependency — install it later with:
 *
 *   npm install --workspace apps/web @sentry/nextjs
 *
 * Then set NEXT_PUBLIC_SENTRY_DSN + SENTRY_AUTH_TOKEN in Vercel and
 * source-map upload happens during `next build`.
 *
 * Until then, these helpers are no-ops so production keeps working.
 */

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

type Sentry = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown) => void;
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
  s.init({
    dsn: DSN,
    tracesSampleRate: 0.1,
    replaysOnErrorSampleRate: 0.0,
    replaysSessionSampleRate: 0.0,
    environment: process.env.NEXT_PUBLIC_SC2TOOLS_ENV || "production",
  });
}

export async function captureException(err: unknown): Promise<void> {
  const s = await getSentry();
  if (s) {
    s.captureException(err);
  } else if (typeof console !== "undefined") {
    console.error(err);
  }
}
