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
// Typed search text: quick search's recent games and signed-out Community search (ADR 0069 amendment),
// counted by the key the API's qs parser reads, so search[], search[0] and [search] are all `search`.
const SEARCH_QUERY_ROUTES = [
  { path: /^\/v1\/replays\/?$/iu, root: "search" },
  { path: /^\/v1\/community\/builds\/?$/iu, root: "q" },
];
function queryRoot(name: string): string {
  const open = name.indexOf("["), close = open === 0 ? name.indexOf("]") : -1;
  return open > 0 ? name.slice(0, open) : close > 0 ? name.slice(1, close) : name;
}

/** Longest stored page path; mirrors the API's cap. */
export const PAGE_PATH_MAX = 200;
/** Longest stored request path; mirrors the API's cap. */
export const REQUEST_PATH_MAX = 160;

const BASE = "http://report.invalid";

function cap(value: string, max: number): string {
  return value.slice(0, max);
}

/**
 * A request URL (absolute, or a path) as "/path?query" with credential
 * path segments and sensitive query values redacted. "" when it is not
 * a usable path.
 *
 * Example: `sanitiseRequestPath("https://api.sc2tools.com/v1/multichat/abc/config?token=x&limit=5")`
 * → "/v1/multichat/[redacted]/config?token=%5Bredacted%5D&limit=5"; typed search text in
 * "/v1/replays?search=…" and "/v1/community/builds?q=…" is redacted the same way.
 */
export function sanitiseRequestPath(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim(), BASE);
  } catch {
    return "";
  }
  // Every parameter on this private endpoint is omitted, including rejected
  // GETs and unknown keys. Reports keep its fixed operational route only.
  if (/^\/v1\/search\/quick\/?$/iu.test(parsed.pathname)) return "/v1/search/quick";
  const path = parsed.pathname.replace(CREDENTIAL_PATH_SEGMENT, "/$1/[redacted]");
  const isOauthCallback = OAUTH_CALLBACK_PATH.test(parsed.pathname);
  const searchRoot = SEARCH_QUERY_ROUTES.find(route => route.path.test(parsed.pathname))?.root;
  for (const key of new Set(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key) || (searchRoot !== undefined && queryRoot(key).toLowerCase() === searchRoot)
      || (isOauthCallback && OAUTH_CALLBACK_SENSITIVE_QUERY_KEYS.has(key.toLowerCase()))) {
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
    .replace(TOKEN_PAGE_SEGMENT, "/$1/[redacted]")
    .replace(CREDENTIAL_PATH_SEGMENT, "/$1/[redacted]");
  return cap(redacted, PAGE_PATH_MAX);
}
