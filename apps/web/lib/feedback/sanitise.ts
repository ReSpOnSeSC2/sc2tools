/**
 * Credential-free paths for bug reports. The same rules as the API's
 * request logs (apps/api/src/middleware/requestLogging.js
 * sanitiseRequestUrl), plus the browser-source pages whose URL is
 * their credential (/overlay/<token>, /dock/<token>). The API runs its
 * own copy of these rules again before a report is stored.
 */

// API routes whose path segment after the prefix is a credential (overlay
// and chat-bot tokens, pairing codes) or a live game key holding both
// players' names.
const CREDENTIAL_PATH_SEGMENT =
  /\/(multichat|chatbot|overlay-tokens|device-pairings|build-intents\/live)\/[^/?#]+/giu;
// OBS browser sources and the Stream Dock authenticate with the token in the URL.
const TOKEN_PAGE_SEGMENT = /^\/(overlay|dock)\/[^/?#]+/iu;
const SENSITIVE_QUERY_KEY = /(authorization|credential|key|secret|signature|token)/iu;
const OAUTH_CALLBACK_PATH = /^\/v1\/integrations\/(?:twitch|kick|youtube)\/callback\/?$/iu;
const OAUTH_CALLBACK_SENSITIVE_QUERY_KEYS = new Set(["code", "state", "error", "error_description", "error_uri"]);

/** Longest stored page path; mirrors the API's cap. */
export const PAGE_PATH_MAX = 200;
/** Longest stored request path; mirrors the API's cap. */
export const REQUEST_PATH_MAX = 160;

const BASE = "http://report.invalid";

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * A request URL (absolute, or a path) as "/path?query" with credential
 * path segments and sensitive query values redacted. "" when it is not
 * a usable path.
 *
 * Example: `sanitiseRequestPath("https://api.sc2tools.com/v1/multichat/abc/config?token=x&limit=5")`
 * → "/v1/multichat/[redacted]/config?token=%5Bredacted%5D&limit=5".
 */
export function sanitiseRequestPath(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim(), BASE);
  } catch {
    return "";
  }
  const path = parsed.pathname.replace(CREDENTIAL_PATH_SEGMENT, (_match, route: string) => `/${route}/[redacted]`);
  const isOauthCallback = OAUTH_CALLBACK_PATH.test(parsed.pathname);
  for (const key of new Set(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key) || (isOauthCallback && OAUTH_CALLBACK_SENSITIVE_QUERY_KEYS.has(key.toLowerCase()))) {
      parsed.searchParams.set(key, "[redacted]");
    }
  }
  return cap(`${path}${parsed.search}`, REQUEST_PATH_MAX);
}

/**
 * The page a report was sent from: the path only (no query string or
 * #anchor), with browser-source tokens and credential segments redacted.
 *
 * Example: `sanitisePagePath("/overlay/abc123/widget/scout?debug=1")` → "/overlay/[redacted]/widget/scout".
 */
export function sanitisePagePath(raw: string): string {
  const path = raw.trim().split(/[?#]/u)[0];
  if (!path.startsWith("/")) return "";
  const redacted = path
    .replace(TOKEN_PAGE_SEGMENT, (_match, root: string) => `/${root}/[redacted]`)
    .replace(CREDENTIAL_PATH_SEGMENT, (_match, route: string) => `/${route}/[redacted]`);
  return cap(redacted, PAGE_PATH_MAX);
}
