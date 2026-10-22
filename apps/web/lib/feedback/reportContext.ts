import type { FailedRequest } from "./failedRequests";
import { sanitisePagePath } from "./sanitise";

/**
 * What a bug report carries besides the player's own words, and how the
 * report form lists it. The player sees every item under "Included with
 * your report" and can untick any of them; only the ticked ones are sent.
 * Mirrors the API's whitelist (apps/api/src/services/reportContext.js):
 * the same field names, caps and 2 KB limit.
 */

export type ReportType = "problem" | "idea" | "question";
export const REPORT_TYPES: readonly ReportType[] = ["problem", "idea", "question"];

/** Desktop app state from /v1/me: heartbeat fresh, stale, or never paired. */
export type AgentStatus = "online" | "offline" | "not_paired";

export interface ReportContext {
  /** Page path, no query string. */
  page?: string;
  /** Web build (commit) the page was served from. */
  build?: string;
  /** "Chrome 129 on Windows". */
  browser?: string;
  /** "1440x900" (CSS pixels). */
  viewport?: string;
  agentVersion?: string;
  agentStatus?: AgentStatus;
  failedRequests?: FailedRequest[];
}

/** Each line of "Included with your report", untickable on its own. */
export type ReportContextItemId = "page" | "build" | "browser" | "viewport" | "agent" | "requests";

export interface ReportContextItem {
  id: ReportContextItemId;
  label: string;
  /** Exactly what is sent, in words. */
  value: string;
  /** Extra lines (the failed requests). */
  details?: string[];
}

/** The /v1/me fields the report reads. */
export interface ReportMeProbe {
  agentVersion?: string | null;
  agentPaired?: boolean;
  agentLastSeenAt?: string | null;
}

/** Serialized size cap for a context, in bytes of JSON (the API refuses more). */
export const REPORT_CONTEXT_MAX_BYTES = 2048;

const LIMITS = { build: 40, browser: 120, viewport: 20, agentVersion: 32 } as const;
/** Shown build length: a short commit hash is enough to find the deploy. */
const BUILD_SHA_CHARS = 12;
/**
 * The desktop app heartbeats every 60 s; two missed beats read as offline
 * (same window as Settings → Overlay's agent indicator).
 */
const AGENT_ONLINE_MS = 150_000;

/** The web build this page was served from, or undefined in local dev. */
export function webBuildSha(env: string | undefined = process.env.NEXT_PUBLIC_BUILD_SHA): string | undefined {
  const sha = env?.trim();
  return sha ? sha.slice(0, BUILD_SHA_CHARS) : undefined;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\/(\d+)/u, "Edge"],
  [/OPR\/(\d+)/u, "Opera"],
  [/SamsungBrowser\/(\d+)/u, "Samsung Internet"],
  [/(?:Firefox|FxiOS)\/(\d+)/u, "Firefox"],
  [/(?:Chrome|CriOS)\/(\d+)/u, "Chrome"],
  [/Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//u, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/Windows NT/u, "Windows"],
  [/iPhone|iPad|iPod/u, "iOS"],
  [/Android/u, "Android"],
  [/CrOS/u, "ChromeOS"],
  [/Mac OS X|Macintosh/u, "macOS"],
  [/Linux/u, "Linux"],
];

/**
 * Browser name, major version and OS from a user-agent string.
 *
 * Example: a Windows Chrome 129 user agent → "Chrome 129 on Windows".
 */
export function describeBrowser(userAgent: string): string {
  let browser = "Unknown browser";
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return (system ? `${browser} on ${system}` : browser).slice(0, LIMITS.browser);
}

/** The desktop app's state from /v1/me at `now` (epoch ms). */
export function agentStatusFrom(me: ReportMeProbe, now: number): AgentStatus {
  if (!me.agentPaired) return "not_paired";
  const seen = me.agentLastSeenAt ? Date.parse(me.agentLastSeenAt) : NaN;
  return Number.isFinite(seen) && now - seen < AGENT_ONLINE_MS ? "online" : "offline";
}

export interface ReportContextInput {
  pathname: string;
  userAgent: string;
  viewport: { width: number; height: number };
  failedRequests: FailedRequest[];
  /** /v1/me, once loaded. */
  me?: ReportMeProbe;
  build?: string;
  now: number;
}

/** Everything a report can carry, before the player unticks anything. */
export function collectReportContext(input: ReportContextInput): ReportContext {
  const context: ReportContext = {};
  const page = sanitisePagePath(input.pathname);
  if (page) context.page = page;
  const build = input.build?.slice(0, LIMITS.build);
  if (build) context.build = build;
  if (input.userAgent) context.browser = describeBrowser(input.userAgent);
  const { width, height } = input.viewport;
  if (width > 0 && height > 0) {
    context.viewport = `${Math.round(width)}x${Math.round(height)}`.slice(0, LIMITS.viewport);
  }
  if (input.me) {
    context.agentStatus = agentStatusFrom(input.me, input.now);
    const version = input.me.agentVersion?.trim().slice(0, LIMITS.agentVersion);
    if (version && input.me.agentPaired) context.agentVersion = version;
  }
  if (input.failedRequests.length > 0) context.failedRequests = input.failedRequests;
  return context;
}

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  online: "online",
  offline: "offline",
  not_paired: "Not paired",
};

/** One line per failed request: "500 · /v1/games · internal_error · ref req_1". */
export function describeFailedRequest(request: FailedRequest): string {
  return [
    request.status === 0 ? "No response" : String(request.status),
    request.path,
    request.code,
    request.requestId ? `ref ${request.requestId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The lines of "Included with your report", in display order. */
export function reportContextItems(context: ReportContext): ReportContextItem[] {
  const items: ReportContextItem[] = [];
  if (context.page) items.push({ id: "page", label: "Page", value: context.page });
  if (context.build) items.push({ id: "build", label: "Site version", value: context.build });
  if (context.browser) items.push({ id: "browser", label: "Browser", value: context.browser });
  if (context.viewport) {
    items.push({ id: "viewport", label: "Window size", value: context.viewport.replace("x", " × ") });
  }
  if (context.agentStatus) {
    const status = AGENT_STATUS_LABEL[context.agentStatus];
    items.push({
      id: "agent",
      label: "Desktop app",
      value: context.agentVersion ? `v${context.agentVersion.replace(/^v/u, "")}, ${status}` : capitalise(status),
    });
  }
  const requests = context.failedRequests ?? [];
  if (requests.length > 0) {
    items.push({
      id: "requests",
      label: "Recent errors",
      value: requests.length === 1 ? "1 failed request" : `${requests.length} failed requests`,
      // Newest first: the one that just went wrong leads.
      details: [...requests].reverse().map(describeFailedRequest),
    });
  }
  return items;
}

/**
 * A stored context as one compact line for the admin inbox (failed
 * requests are listed separately).
 *
 * Example: → "/app/macro · build 4f9c2ab1d0e3 · 1440×900 · Chrome 129 on Windows · app v0.19.0, online".
 */
export function summariseReportContext(context: ReportContext): string {
  const agent = context.agentStatus
    ? context.agentStatus === "not_paired"
      ? "app not paired"
      : `app ${context.agentVersion ? `v${context.agentVersion.replace(/^v/u, "")}, ` : ""}${AGENT_STATUS_LABEL[context.agentStatus]}`
    : undefined;
  return [
    context.page,
    context.build ? `build ${context.build}` : undefined,
    context.viewport?.replace("x", "×"),
    context.browser,
    agent,
  ]
    .filter(Boolean)
    .join(" · ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Bytes of JSON a context serializes to. */
export function reportContextBytes(context: ReportContext): number {
  return new TextEncoder().encode(JSON.stringify(context)).length;
}

/**
 * The context to send: only the ticked items, oldest failed requests
 * dropped if it would pass the 2 KB cap. Undefined when nothing is left.
 */
export function pickReportContext(
  context: ReportContext,
  excluded: ReadonlySet<ReportContextItemId>,
): ReportContext | undefined {
  const picked: ReportContext = {};
  if (context.page && !excluded.has("page")) picked.page = context.page;
  if (context.build && !excluded.has("build")) picked.build = context.build;
  if (context.browser && !excluded.has("browser")) picked.browser = context.browser;
  if (context.viewport && !excluded.has("viewport")) picked.viewport = context.viewport;
  if (context.agentStatus && !excluded.has("agent")) {
    picked.agentStatus = context.agentStatus;
    if (context.agentVersion) picked.agentVersion = context.agentVersion;
  }
  if (context.failedRequests?.length && !excluded.has("requests")) {
    picked.failedRequests = context.failedRequests.map((request) => ({ ...request }));
  }
  while (reportContextBytes(picked) > REPORT_CONTEXT_MAX_BYTES && picked.failedRequests?.length) {
    picked.failedRequests = picked.failedRequests.slice(1);
    if (picked.failedRequests.length === 0) delete picked.failedRequests;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
