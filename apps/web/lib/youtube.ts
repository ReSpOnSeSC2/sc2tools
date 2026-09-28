/**
 * YouTube URL helpers shared by client surfaces (the stream-dock B-roll
 * library editor and the admin Guides videos panel). Pure and framework
 * free, so server and client code can both import it.
 */

/** A YouTube video id: exactly 11 URL-safe base64 characters. */
export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Path prefixes whose next segment is the video id (youtube.com/<prefix>/<id>). */
const ID_PATH_PREFIXES: ReadonlySet<string> = new Set([
  "embed",
  "live",
  "shorts",
  "v",
  "video",
]);

function isYouTubeHost(hostname: string): boolean {
  return (
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtube-nocookie.com" ||
    hostname.endsWith(".youtube-nocookie.com")
  );
}

function idFromYouTubeUrl(parsed: URL): string {
  const fromQuery = parsed.searchParams.get("v");
  if (fromQuery) return fromQuery;
  const parts = parsed.pathname.split("/").filter(Boolean);
  return ID_PATH_PREFIXES.has(parts[0] ?? "") ? parts[1] ?? "" : "";
}

/**
 * Accept a bare video ID or the common YouTube watch/share/live URL shapes.
 *
 * Example: `parseYouTubeVideoId("https://youtu.be/YcTMc_Ee11w?si=x")` →
 * "YcTMc_Ee11w"; `parseYouTubeVideoId("https://example.com/watch?v=YcTMc_Ee11w")` → null.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (YOUTUBE_VIDEO_ID_RE.test(value)) return value;

  let parsed: URL;
  try {
    parsed = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let candidate = "";
  if (hostname === "youtu.be") {
    candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (isYouTubeHost(hostname)) {
    candidate = idFromYouTubeUrl(parsed);
  }

  return YOUTUBE_VIDEO_ID_RE.test(candidate) ? candidate : null;
}
