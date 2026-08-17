// Resolution of admin-gated SC2 3D alert media.
//
// The rendered SC2 presets are derived from rights-controlled game assets, so
// their media is deliberately NOT bundled into apps/web/public -- anything
// under public/ is served unauthenticated, which would defeat the admin gate.
// The files live only in the private R2 bucket, and the API hands out
// short-lived presigned URLs to admin sessions via
// GET /v1/multichat/alert-media.
//
// The catalog stores stable object paths ("/alerts/sc2-3d/<file>"), which are
// used as the lookup key against the presigned map. A non-admin gets an empty
// map, every lookup misses, and ChatAlertCard falls back to the code-native
// static art -- so the renderer degrades cleanly instead of emitting broken
// media requests.

export interface AlertMediaGrant {
  /** Map of catalog path -> short-lived presigned URL. */
  readonly urls: Readonly<Record<string, string>>;
  /** Epoch milliseconds after which the presigned URLs stop working. */
  readonly expiresAt: number;
}

export const EMPTY_ALERT_MEDIA_GRANT: AlertMediaGrant = {
  urls: {},
  expiresAt: 0,
};

/** Re-request slightly before expiry so a render never races the deadline. */
const RENEW_SKEW_MS = 30_000;

/** True when the grant is missing, empty, or close enough to expiry to refetch. */
export function grantNeedsRefresh(
  grant: AlertMediaGrant | null | undefined,
  now: number,
): boolean {
  if (!grant || grant.expiresAt <= 0) return true;
  return now >= grant.expiresAt - RENEW_SKEW_MS;
}

/**
 * Path prefix whose media is admin-gated and lives only in private R2.
 *
 * Only the rendered SC2 presets are restricted. Every other preset that
 * references media points at locally hosted, licensed art that ships in the
 * build and must keep resolving without a grant -- so gating is decided by
 * prefix, not applied to every path.
 */
export const GATED_MEDIA_PREFIX = "/alerts/sc2-3d/";

/**
 * Opt-in local preview of the gated media, for development only.
 *
 * Deliberately NOT enabled by every non-production build: tests and preview
 * builds should exercise the same gate production does, so leaving it off by
 * default keeps the default behaviour honest. A developer who wants to see the
 * 3D presets without a deployed API sets
 * NEXT_PUBLIC_ALERT_MEDIA_LOCAL_FALLBACK=1 in .env.local and drops the render
 * files into apps/web/public/alerts/sc2-3d (that directory ignores media, so
 * they stay untracked).
 *
 * The NODE_ENV check is a second lock: even if the flag reaches a production
 * environment, the branch is inlined to false and eliminated from the bundle.
 */
const ALLOW_LOCAL_GATED_MEDIA =
  process.env.NODE_ENV !== "production"
  && process.env.NEXT_PUBLIC_ALERT_MEDIA_LOCAL_FALLBACK === "1";

/** Whether this catalog path is one of the admin-gated SC2 3D objects. */
export function isGatedMediaPath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith(GATED_MEDIA_PREFIX);
}

/**
 * Resolve a catalog media path for rendering.
 *
 *   * Absolute URLs pass through untouched.
 *   * A path present in the grant resolves to its presigned URL.
 *   * A gated path with no grant entry returns undefined -- the normal
 *     non-admin case, and the caller's signal to render static fallback art.
 *   * Any other path passes through unchanged, because it refers to locally
 *     hosted licensed art served from the build.
 */
export function resolveAlertMediaUrl(
  path: string | undefined,
  grant: AlertMediaGrant | null | undefined,
): string | undefined {
  if (!path) return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return path;
  const signed = grant?.urls?.[path];
  if (signed) return signed;
  if (!isGatedMediaPath(path)) return path;
  // Opt-in local preview only; see ALLOW_LOCAL_GATED_MEDIA above. Off by
  // default so tests and preview builds see the real gate.
  if (ALLOW_LOCAL_GATED_MEDIA) return path;
  return undefined;
}

// --- grant store -----------------------------------------------------------
//
// A module-level store rather than context: the overlay renders alert cards
// from several disconnected roots (OBS widget, Settings preview), and every
// one of them wants the same grant. Kept sync-external-store shaped so React
// subscribes without an extra provider.

let currentGrant: AlertMediaGrant = EMPTY_ALERT_MEDIA_GRANT;
const listeners = new Set<() => void>();

/** Replace the active grant and notify subscribers. */
export function setAlertMediaGrant(grant: AlertMediaGrant): void {
  currentGrant = grant;
  for (const listener of listeners) listener();
}

/** Current grant. Empty until an admin session fetches one. */
export function getAlertMediaGrant(): AlertMediaGrant {
  return currentGrant;
}

/** Server render has no grant; keeps useSyncExternalStore hydration stable. */
export function getAlertMediaGrantServerSnapshot(): AlertMediaGrant {
  return EMPTY_ALERT_MEDIA_GRANT;
}

export function subscribeAlertMediaGrant(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Normalise an API payload into a grant. Tolerates a missing or malformed
 * body by returning the empty grant rather than throwing into a render.
 */
export function toAlertMediaGrant(payload: unknown): AlertMediaGrant {
  if (!payload || typeof payload !== "object") return EMPTY_ALERT_MEDIA_GRANT;
  const body = payload as { urls?: unknown; expiresIn?: unknown };
  const rawUrls = body.urls;
  if (!rawUrls || typeof rawUrls !== "object") return EMPTY_ALERT_MEDIA_GRANT;

  const urls: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawUrls as Record<string, unknown>)) {
    if (typeof value === "string" && value) urls[key] = value;
  }

  const expiresIn =
    typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)
      ? Math.max(0, body.expiresIn)
      : 0;

  return { urls, expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0 };
}
