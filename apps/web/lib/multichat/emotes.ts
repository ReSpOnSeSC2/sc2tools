// Multichat emotes — pure helpers for rendering platform emotes as
// images. Engines attach an optional ``emotes`` array to parsed
// messages (code + CDN url, nothing else); the renderer splits the
// message text on those codes and swaps each occurrence for an <img>.
//
// Only first-party CDN url shapes are produced here — no third-party
// emote services, no lookups, no I/O. When ``appearance.emoteImages``
// is off (or a platform ships no emote metadata) the text renders
// exactly as before, so this module is a pure enhancement layer.

/** One renderable emote: the text it replaces + the image that replaces it. */
export interface ChatEmote {
  code: string;
  url: string;
}

/**
 * Twitch CDN url for an emote id (the `emotes=` IRC tag carries ids).
 * `default/dark/2.0` = theme-appropriate, 2x density — crisp at chat
 * sizes without pulling the 112px 3.0 asset.
 */
export function twitchEmoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`;
}

/** Kick CDN url for an emote id (the `[emote:id:name]` markup carries ids). */
export function kickEmoteUrl(id: string): string {
  return `https://files.kick.com/emotes/${encodeURIComponent(id)}/fullsize`;
}

/** Escape a literal emote code for use inside a RegExp alternation. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split ``text`` into renderable segments: plain strings interleaved
 * with ChatEmote entries wherever an emote code occurs. Longer codes
 * match first so "KEKWait" never half-matches "KEKW". Pure and
 * order-preserving; with no emotes (or no matches) the result is the
 * original text as a single segment.
 */
export function renderTextWithEmotes(
  text: string,
  emotes: ReadonlyArray<ChatEmote>,
): Array<string | ChatEmote> {
  const usable = emotes.filter((e) => e.code.length > 0);
  if (text.length === 0) return [];
  if (usable.length === 0) return [text];
  const byCode = new Map(usable.map((e) => [e.code, e]));
  const pattern = new RegExp(
    [...byCode.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  const out: Array<string | ChatEmote> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const emote = byCode.get(match[0]);
    if (emote) out.push(emote);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
