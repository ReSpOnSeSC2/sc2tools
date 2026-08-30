/**
 * Replay lists (including their trailing-slash and metadata-image URLs) stay
 * public. Only a non-empty per-game segment is protected. This explicit test
 * avoids catch-all matcher semantics where `(.*)` can also match an empty
 * trailing segment and accidentally put the public list behind Clerk.
 */
export function isSharedReplayDetailPath(pathname: string): boolean {
  const match = /^\/(?:players|p)\/[^/]+\/replays\/([^/]+)\/?$/.exec(pathname);
  if (!match) return false;
  return !/^(?:opengraph-image|twitter-image|icon|apple-icon)(?:[.-].*)?$/.test(
    match[1],
  );
}
