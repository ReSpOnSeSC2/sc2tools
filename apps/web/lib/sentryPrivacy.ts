import { sanitiseRequestPath } from "./feedback/sanitise";
import { canonicalReportCardPath } from "./instant/reportCardRoute";
import { PRACTICE_LINK_PATTERN, PRACTICE_LINK_ROUTE } from "./practice/practiceLinkPath";
import { ROOM_PATH, ROOM_ROUTE } from "./matchRoomRoute";

// Browser Sentry keeps no typed search text or credential path (ADR 0069,
// 2026-11-01 amendment). Request URLs in fetch and XHR breadcrumbs and in
// request spans pass through the problem-report sanitiser, which redacts
// replay-library and Community search text, credential path segments and
// sensitive query values. Loaded by lib/sentry.ts only when a DSN is set.

type Breadcrumb = { category?: string; data?: Record<string, unknown> };
type Span = { description?: string; data?: Record<string, unknown> };
type Transaction = { spans?: Span[] };
const URL_FIELDS = ["url", "http.url", "url.full", "http.target", "url.path"] as const;
// The query again on its own; the scrubbed URL keeps its safe parameters.
const QUERY_FIELDS = ["http.query", "url.query", "http.fragment", "url.fragment"] as const;
const REQUEST_NAME = /^([A-Z]+\s+)(\S+)$/u;

function scrubUrl(value: unknown): unknown {
  return typeof value === "string" ? sanitizeTelemetryPath(value) ?? (sanitiseRequestPath(value) || "[redacted]") : value;
}

function sanitizeTelemetryPath(value: string): string | null {
  try {
    const { pathname } = new URL(value, "https://sc2tools.com");
    if (ROOM_ROUTE.test(pathname)) return ROOM_PATH;
    return PRACTICE_LINK_ROUTE.test(pathname) ? PRACTICE_LINK_PATTERN : canonicalReportCardPath(pathname);
  } catch {
    return null;
  }
}

function scrubNavigation(value: unknown): unknown {
  return typeof value === "string" ? sanitizeTelemetryPath(value) ?? value : value;
}

/** Example: a fetch breadcrumb for "https://api/v1/replays?search=Bob" keeps "/v1/replays?search=%5Bredacted%5D". */
export function scrubBreadcrumb<T extends Breadcrumb>(breadcrumb: T): T {
  const data = breadcrumb.data;
  if (breadcrumb.category === "navigation" && data) {
    const from = scrubNavigation(data.from), to = scrubNavigation(data.to);
    if (from !== data.from || to !== data.to) return { ...breadcrumb, data: { ...data, from, to } };
  }
  if ((breadcrumb.category !== "fetch" && breadcrumb.category !== "xhr") || !data || !Object.hasOwn(data, "url")) return breadcrumb;
  return { ...breadcrumb, data: { ...data, url: scrubUrl(data.url) } };
}

/** A request span's URL fields and its "GET <url>" name, scrubbed the same way. */
export function scrubSpan<T extends Span>(span: T): T {
  const data = span.data ? { ...span.data } : undefined;
  if (data) {
    for (const key of URL_FIELDS) if (Object.hasOwn(data, key)) data[key] = scrubUrl(data[key]);
    for (const key of QUERY_FIELDS) delete data[key];
  }
  const name = typeof span.description === "string" ? REQUEST_NAME.exec(span.description) : null;
  return { ...span, ...(data ? { data } : {}),
    ...(name ? { description: `${name[1]}${String(scrubUrl(name[2]))}` } : {}) };
}

/** Every child span of a transaction event, in case a span skipped beforeSendSpan. */
export function scrubTransaction<T extends Transaction>(event: T): T {
  return Array.isArray(event.spans) ? { ...event, spans: event.spans.map(scrubSpan) } : event;
}
