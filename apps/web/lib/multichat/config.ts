// Multichat config helpers — pure input normalisation for the
// Settings UI. Streamers paste whatever they have (URLs, @handles,
// JSON blobs); these helpers turn each paste into the canonical
// stored shape or reject it with null.

import { normalizeTwitchChannel } from "./twitch";

/** "kick.com/name", "@Name", "Name" → bare lowercase slug. */
export function normalizeKickChannelInput(raw: string): string | null {
  let input = String(raw || "").trim().toLowerCase();
  input = input.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (input.startsWith("kick.com/")) input = input.slice("kick.com/".length);
  input = input.split(/[/?#]/)[0].replace(/^@/, "");
  return /^[a-z0-9_-]{2,40}$/.test(input) ? input : null;
}

/** "@name", "tiktok.com/@name/live", "name" → bare lowercase username. */
export function normalizeTikTokUsernameInput(raw: string): string | null {
  let input = String(raw || "").trim().toLowerCase();
  input = input.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (input.startsWith("tiktok.com/")) input = input.slice("tiktok.com/".length);
  input = input.split(/[/?#]/)[0].replace(/^@/, "");
  return /^[a-z0-9._]{2,32}$/.test(input) ? input : null;
}

/**
 * The guided Kick fallback accepts either a bare chatroom id ("4242")
 * or the whole JSON blob pasted from kick.com/api/v2/channels/<slug>
 * (which a real browser can open even when Cloudflare blocks server
 * lookups). Extracts `chatroom.id` from either.
 */
export function parseKickChatroomInput(raw: string): number | null {
  const input = String(raw || "").trim();
  if (!input) return null;
  if (/^\d{1,12}$/.test(input)) {
    const id = Number(input);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  try {
    const json = JSON.parse(input) as { chatroom?: { id?: unknown } };
    const id = json?.chatroom?.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    // Last resort: fish `"chatroom":{"id":NNN}` out of a partial paste.
    const m = input.match(/"chatroom"\s*:\s*\{\s*"id"\s*:\s*(\d{1,12})/);
    return m ? Number(m[1]) : null;
  }
}

export { normalizeTwitchChannel };
