/** The one opponent's authenticated resources and public channel resolutions. */
export function isOpponentKey(pulseId: string) {
  const base = `/v1/opponents/${encodeURIComponent(pulseId)}`;
  return (key: unknown): boolean => Array.isArray(key) && (key[0] === "player-channels"
    || (key[0] === "authenticated-api" && typeof key[2] === "string"
      && (key[2].split(/[?#]/)[0] === base || key[2].startsWith(`${base}/`))));
}
