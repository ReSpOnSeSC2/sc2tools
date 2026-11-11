/**
 * Revocable single-game share links (API: apps/api/src/routes/gameShares.js).
 *
 * The owner creates one live link per game; anyone holding it can open the
 * game's redacted analysis and map replay at /g/<token> without an account.
 * The token is the page's credential: keep it out of logs and analytics
 * (lib/feedback/sanitise.ts and lib/analytics/pageLocation.ts redact it).
 */

/** The 16-character base64url token format (the review id format). */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

export interface GameShare {
  token: string;
  gameId: string;
  /** Site path of the public page, "/g/<token>". */
  url: string;
  active: boolean;
  createdAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface GameShareList {
  shares: GameShare[];
  /** Live links across all of the owner's games. */
  activeCount: number;
  limit: number;
}

/** Owner list/create path for one game. */
export function gameSharesPath(gameId: string): string {
  return `/v1/games/${encodeURIComponent(gameId)}/shares`;
}

/** Owner revoke path; public API reads share the same prefix. */
export function shareApiPath(token: string): string {
  return `/v1/shares/${encodeURIComponent(token)}`;
}

/**
 * The absolute public URL for a share, optionally at a page section.
 *
 * Example: `shareLinkUrl("AbCdEfGhIjKlMnOp", "https://sc2tools.com")`
 * → "https://sc2tools.com/g/AbCdEfGhIjKlMnOp".
 */
export function shareLinkUrl(token: string, origin: string, hash?: string): string {
  return `${origin}/g/${encodeURIComponent(token)}${hash ? `#${hash}` : ""}`;
}

/** The game's live link, when the list has one. */
export function activeShare(list: GameShareList | null | undefined): GameShare | null {
  const shares = Array.isArray(list?.shares) ? list.shares : [];
  return shares.find((share) => share?.active === true && SHARE_TOKEN_RE.test(String(share.token))) ?? null;
}
