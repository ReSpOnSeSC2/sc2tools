export const STREAM_VIEWER_PATH = "/p/:handle/live";
export const STREAM_VIEWER_API_PATH = "/v1/public/players/:slug/live";

/** Fixed telemetry labels for the public page and its uncached API. */
export function streamViewerTelemetryPath(path: string): string | null {
  if (/^\/p\/[^/?#]+\/live\/?(?:[?#]|$)/i.test(path)) return STREAM_VIEWER_PATH;
  if (/^\/v1\/public\/players\/[^/?#]+\/live\/?(?:[?#]|$)/i.test(path)) return STREAM_VIEWER_API_PATH;
  return null;
}

export function streamViewerApiPath(handle: string): string {
  return `/v1/public/players/${encodeURIComponent(handle)}/live`;
}
