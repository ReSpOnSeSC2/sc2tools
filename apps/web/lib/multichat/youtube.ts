// Each live broadcast owns its cursor. Channel discovery can add a portrait or
// landscape broadcast without resetting the chats already being polled.

import { EVENT_CAP, isChatEventKind } from "./events";
import { FEED_CAP } from "./feed";
import type { ChatEngine, EngineCallbacks, PlatformState } from "./types";

const DISCOVERY_INTERVAL_MS = 60_000;
const ERROR_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const FIRST_POLL_CLOCK_SKEW_MS = 5_000;
const MAX_SESSIONS = 10;
const MAX_RETAINED_SESSIONS = 20;

interface ResolvedSession {
  videoId?: string;
  continuation: string;
  clientVersion: string;
}

interface WireMessage {
  id: string;
  user: string;
  text: string;
  badges?: string[];
  atMs: number;
}

interface WireEvent {
  id: string;
  kind: string;
  user: string;
  detail: string;
  amount?: string;
  atMs: number;
  updateKey?: string;
  updateVersion?: number;
}

interface PollResponse {
  messages: WireMessage[];
  events?: WireEvent[];
  continuation: string | null;
  timeoutMs: number;
  done: boolean;
}

interface RetainedSession {
  startedAtMs: number;
  retryAtMs: number;
  messages: Set<string>;
  events: Set<string>;
}

interface Session extends ResolvedSession {
  key: string;
  firstPoll: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  state: PlatformState;
  detail?: string;
  retained: RetainedSession;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Accept both the original singular relay and the multi-broadcast response. */
function resolvedSessions(raw: unknown): ResolvedSession[] {
  const body = record(raw);
  if (!body) return [];
  const candidates = Array.isArray(body.sessions) ? body.sessions : [body];
  const sessions = new Map<string, ResolvedSession>();
  for (const candidate of candidates.slice(0, MAX_SESSIONS * 2)) {
    const item = record(candidate);
    if (
      !item || typeof item.continuation !== "string" ||
      !item.continuation || item.continuation.length > 4096 ||
      typeof item.clientVersion !== "string" || !item.clientVersion ||
      item.clientVersion.length > 100 ||
      (item.videoId !== undefined &&
        (typeof item.videoId !== "string" || !/^[\w-]{11}$/.test(item.videoId)))
    ) continue;
    const videoId = typeof item.videoId === "string" ? item.videoId : undefined;
    // Multi-session responses need stable identities. A legacy singular
    // response may omit videoId, and keeps its original unprefixed IDs.
    if (Array.isArray(body.sessions) && !videoId) continue;
    sessions.set(videoId ?? "legacy", {
      ...(videoId ? { videoId } : {}),
      continuation: item.continuation,
      clientVersion: item.clientVersion,
    });
    if (sessions.size === MAX_SESSIONS) break;
  }
  return [...sessions.values()];
}

function remember(seen: Set<string>, id: string, cap: number): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  while (seen.size > cap) seen.delete(seen.values().next().value!);
  return true;
}

function pollDelay(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1_000, Math.min(30_000, value))
    : 5_000;
}

export function createYoutubeChat(opts: {
  apiBase: string;
  token: string;
  channel: string;
  callbacks: EngineCallbacks;
}): ChatEngine {
  const { apiBase, token, channel, callbacks } = opts;
  const base = `${apiBase}/v1/multichat/${encodeURIComponent(token)}`;
  const sessions = new Map<string, Session>();
  const retained = new Map<string, RetainedSession>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let resolveInFlight = false;
  let resolveTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveDueAt = Infinity;
  let discoveryState: PlatformState = "connecting";
  let discoveryDetail: string | undefined;
  let lastStatus = "";

  const publishStatus = () => {
    if (closed) return;
    const active = [...sessions.values()];
    const connected = active.filter((session) => session.state === "connected");
    const retrying = active.length - connected.length;
    const state = connected.length ? "connected" : active.length
      ? active.some((session) => session.state === "connecting") ? "connecting" : "error"
      : discoveryState;
    const detail = connected.length
      ? active.length > 1
        ? `${connected.length} live chats${retrying ? `; ${retrying} reconnecting` : ""}`
        : undefined
      : active.find((session) => session.detail)?.detail ?? discoveryDetail;
    const signature = `${state}:${detail ?? ""}`;
    if (signature === lastStatus) return;
    lastStatus = signature;
    callbacks.onStatus(state, detail);
  };

  // Include body reads in the timeout, and abort every outstanding request on
  // close. Browsers that resolve an aborted request late still hit guards below.
  const request = async (url: string, init?: RequestInit) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init, signal: controller.signal, cache: "no-store",
      });
      const body: unknown = await response.json().catch((error: unknown) => {
        if (response.ok) throw error;
        return null;
      });
      return { response, body };
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  const scheduleDiscovery = (delay: number) => {
    if (closed) return;
    const dueAt = Date.now() + delay;
    if (resolveTimer && resolveDueAt <= dueAt) return;
    if (resolveTimer) clearTimeout(resolveTimer);
    resolveDueAt = dueAt;
    resolveTimer = setTimeout(() => {
      resolveTimer = null;
      resolveDueAt = Infinity;
      void discover();
    }, delay);
  };

  const schedulePoll = (session: Session, delay: number) => {
    if (closed || sessions.get(session.key) !== session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      void poll(session);
    }, delay);
  };

  const retire = (session: Session, invalid = false) => {
    if (sessions.get(session.key) !== session) return;
    if (session.timer) clearTimeout(session.timer);
    sessions.delete(session.key);
    // Ended broadcasts can remain in a briefly cached resolve response. Do
    // not re-add them on each sibling poll; invalid cursors may retry sooner.
    session.retained.retryAtMs = Date.now() + (invalid ? ERROR_RETRY_MS : DISCOVERY_INTERVAL_MS);
    discoveryState = invalid ? "connecting" : "ended";
    discoveryDetail = invalid ? "chat cursor expired; reconnecting" : undefined;
    publishStatus();
    scheduleDiscovery(invalid ? ERROR_RETRY_MS : DISCOVERY_INTERVAL_MS);
  };

  const retryPoll = (session: Session, state: PlatformState, detail: string, delay: number) => {
    session.state = state;
    session.detail = detail;
    publishStatus();
    schedulePoll(session, delay);
  };

  const poll = async (session: Session) => {
    if (closed || session.inFlight || sessions.get(session.key) !== session) return;
    session.inFlight = true;
    try {
      const { response, body } = await request(`${base}/youtube/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ continuation: session.continuation, clientVersion: session.clientVersion }),
      });
      if (closed || sessions.get(session.key) !== session) return;
      if (!response.ok) {
        const code = record(record(body)?.error)?.code;
        if (response.status === 400 || code === "invalid_continuation" || code === "continuation_expired") {
          retire(session, true);
        } else {
          retryPoll(session, response.status === 429 || response.status === 503 ? "connecting" : "error",
            response.status === 429 ? "rate limited; retrying" : `poll ${response.status}; retrying`,
            retryAfterMs(response.headers.get("retry-after"), ERROR_RETRY_MS));
        }
        return;
      }
      const data = record(body) as unknown as PollResponse | null;
      if (
        !data || !Array.isArray(data.messages) ||
        (data.events !== undefined && !Array.isArray(data.events)) ||
        (data.continuation !== null &&
          (typeof data.continuation !== "string" || !data.continuation || data.continuation.length > 4096))
      ) throw new Error("invalid chat response");
      session.state = "connected";
      session.detail = undefined;
      publishStatus();
      const prefix = session.videoId ? `${session.videoId}:` : "";
      const cutoff = session.retained.startedAtMs - FIRST_POLL_CLOCK_SKEW_MS;
      for (const message of data.messages.slice(-FEED_CAP)) {
        if (!message || typeof message.id !== "string" || typeof message.user !== "string" ||
          typeof message.text !== "string" || !Number.isFinite(message.atMs)) continue;
        if (!remember(session.retained.messages, message.id, FEED_CAP * 2)) continue;
        callbacks.onMessage({
          platform: "youtube", id: `${prefix}${message.id}`, user: message.user,
          text: message.text, atMs: message.atMs,
          badges: (Array.isArray(message.badges) ? message.badges : []).filter(
            (badge): badge is "owner" | "moderator" | "member" | "verified" =>
              ["owner", "moderator", "member", "verified"].includes(badge),
          ),
          ...(session.firstPoll && message.atMs < cutoff ? { backlog: true } : {}),
        });
      }
      for (const event of (data.events ?? []).slice(-EVENT_CAP)) {
        if (!event || typeof event.id !== "string" || typeof event.user !== "string" ||
          typeof event.detail !== "string" || !Number.isFinite(event.atMs) || !isChatEventKind(event.kind)) continue;
        const eventKey = JSON.stringify([event.id, event.updateKey, event.updateVersion, event.amount]);
        if (!remember(session.retained.events, eventKey, EVENT_CAP * 2)) continue;
        callbacks.onEvent?.({
          platform: "youtube", id: `${prefix}${event.id}`, kind: event.kind,
          user: event.user, detail: event.detail, amount: event.amount, atMs: event.atMs,
          ...(session.firstPoll && event.atMs < cutoff ? { replayed: true } : {}),
          ...(event.updateKey ? { updateKey: `${prefix}${event.updateKey}` } : {}),
          ...(Number.isFinite(event.updateVersion) ? { updateVersion: event.updateVersion } : {}),
        });
      }
      session.firstPoll = false;
      if (data.done || !data.continuation) {
        retire(session);
        return;
      }
      session.continuation = data.continuation;
      schedulePoll(session, pollDelay(data.timeoutMs));
    } catch (error) {
      if (closed || sessions.get(session.key) !== session) return;
      // A network outage/5xx must retain the cursor: discovery can jump over
      // messages accumulated during that outage.
      retryPoll(session, "error", String(error).slice(0, 80), ERROR_RETRY_MS);
    } finally {
      session.inFlight = false;
    }
  };

  const discover = async () => {
    if (closed || resolveInFlight) return;
    resolveInFlight = true;
    const discoveryStartedAtMs = Date.now();
    publishStatus();
    try {
      const { response, body } = await request(`${base}/youtube/resolve?channel=${encodeURIComponent(channel)}`);
      if (closed) return;
      if (!response.ok) {
        const code = record(record(body)?.error)?.code;
        discoveryState = code === "not_live" ? "offline" : response.status === 429 || response.status === 503 ? "connecting" : "error";
        discoveryDetail = response.status === 429 ? "rate limited; retrying" : code === "not_live" ? undefined : `resolve ${response.status}`;
        publishStatus();
        scheduleDiscovery(response.status === 429 || response.status === 503
          ? retryAfterMs(response.headers.get("retry-after"), ERROR_RETRY_MS)
          : DISCOVERY_INTERVAL_MS);
        return;
      }
      const next = resolvedSessions(body);
      if (!next.length) throw new Error("invalid chat discovery response");
      discoveryState = "connecting";
      discoveryDetail = undefined;
      for (const resolved of next) {
        const key = resolved.videoId ?? "legacy";
        if (sessions.has(key) || sessions.size >= MAX_SESSIONS) continue;
        let history = retained.get(key);
        if (history && history.retryAtMs > Date.now()) continue;
        if (!history) {
          history = { startedAtMs: discoveryStartedAtMs, retryAtMs: 0, messages: new Set(), events: new Set() };
          retained.set(key, history);
        }
        const session: Session = { ...resolved, key, firstPoll: true, timer: null,
          inFlight: false, state: "connecting", retained: history };
        sessions.set(key, session);
        void poll(session);
      }
      // Healthy chats survive omissions or partially malformed discovery.
      // Their own polls authoritatively report when they end.
      for (const key of retained.keys()) {
        if (retained.size <= MAX_RETAINED_SESSIONS) break;
        if (!sessions.has(key)) retained.delete(key);
      }
      publishStatus();
      const cooldowns = [...retained.entries()]
        .filter(([key, history]) => !sessions.has(key) && history.retryAtMs > Date.now())
        .map(([, history]) => history.retryAtMs - Date.now());
      scheduleDiscovery(Math.min(DISCOVERY_INTERVAL_MS, ...cooldowns));
    } catch (error) {
      if (closed) return;
      discoveryState = "error";
      discoveryDetail = String(error).slice(0, 80);
      publishStatus();
      scheduleDiscovery(ERROR_RETRY_MS);
    } finally {
      resolveInFlight = false;
    }
  };

  void discover();
  return {
    close: () => {
      closed = true;
      if (resolveTimer) clearTimeout(resolveTimer);
      for (const session of sessions.values()) if (session.timer) clearTimeout(session.timer);
      for (const controller of controllers) controller.abort();
      sessions.clear();
      retained.clear();
    },
  };
}

/** Clamp untrusted proxy backpressure without creating a hot retry loop. */
export function retryAfterMs(header: string | null, fallbackMs: number): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.max(1_000, Math.min(30_000, Math.round(seconds * 1_000)));
}
