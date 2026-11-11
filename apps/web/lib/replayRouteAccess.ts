/**
 * Replay lists (including their trailing-slash and metadata-image URLs) stay
 * public. Match a single non-metadata segment so the middleware can
 * distinguish legacy replay detail URLs from public archives and cards.
 */
export function isSharedReplayDetailPath(pathname: string): boolean {
  const match = /^\/(?:players|p)\/[^/]+\/replays\/([^/]+)\/?$/.exec(pathname);
  if (!match) return false;
  return !/^(?:opengraph-image|twitter-image|icon|apple-icon)(?:[.-].*)?$/.test(
    match[1],
  );
}

/** Legacy replay IDs can contain a player's opponent name. The public preview uses only opaque references. */
export function isPublicReplayReference(value: unknown): value is string {
  return typeof value === "string" && /^r-[0-9a-f]{24}$/.test(value);
}

export function isPublicReplayPreviewPath(pathname: string): boolean {
  const match = /^\/(?:players|p)\/[^/]+\/replays\/([^/]+)\/?$/.exec(pathname);
  return !!match && isPublicReplayReference(match[1]);
}

export function legacyReplayArchivePath(pathname: string): string | null {
  return isSharedReplayDetailPath(pathname) && !isPublicReplayPreviewPath(pathname)
    ? pathname.replace(/\/[^/]+\/?$/, "") : null;
}
