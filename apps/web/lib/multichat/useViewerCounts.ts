"use client";

// useViewerCounts — live audience size for the Stream Dock: how many
// people each configured platform is showing right now, plus the
// combined total across all of them.
//
// The numbers come from /v1/multichat/:token/viewers, which reads
// them off the platforms themselves (the browser can't: none of the
// four send CORS headers). Same boot-fetch + slow-refetch shape as
// useEngagementState, with one addition — a hidden tab stops polling
// and refetches the moment it comes back, so a dock parked behind an
// OBS tab all stream doesn't keep four upstreams warm for nobody.
//
// A count of `null` means UNKNOWN, not zero: the platform was
// unreachable (Kick's Cloudflare block, a transient upstream error)
// or, for TikTok, nothing is holding the webcast connection open.
// Consumers render nothing for those — a fake 0 is worse than a gap.

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { chatEventIdentity, type ChatEvent } from "./events";
import { CHAT_PLATFORMS, type ChatPlatform } from "./types";

/** Poll cadence — viewer counts move slowly; the server caches ~20s. */
const REFRESH_MS = 45_000;
/**
 * A raid is realtime but platform viewer APIs are eventually consistent. Keep
 * its party visible briefly while those APIs catch up, then always fall back
 * to the authoritative number. This can never become a permanent inflation.
 */
export const RAID_VIEWER_BOOST_MS = 90_000;
/** Refetch once the API's normal 20s upstream cache has certainly rolled. */
export const RAID_REFRESH_DELAY_MS = 22_000;
/** Never resurrect a raid from a reconnect/backlog as a live audience jump. */
const RAID_EVENT_MAX_AGE_MS = 30_000;
/** Defensive ceiling for malformed/untrusted event payloads. */
const RAID_PARTY_MAX = 10_000_000;
/** A months-long dock session still gets a fixed raid-dedupe memory budget. */
const RAID_SEEN_MAX = 512;

export interface PlatformViewers {
  platform: ChatPlatform;
  /** Live viewers, or null when the count is unknown. */
  viewers: number | null;
  live: boolean;
  /** When the server completed this platform observation (cache-aware). */
  observedAtMs?: number;
  /** True only while a recent raid is waiting for the platform count. */
  raidAdjusted?: boolean;
}

export interface ViewerCounts {
  platforms: PlatformViewers[];
  /** Sum of the KNOWN current per-platform counts; never lifetime views. */
  total: number;
  /** True when at least one configured platform reported unknown. */
  partial: boolean;
  /** False until the first successful response — the UI stays blank. */
  loaded: boolean;
  /** At least one displayed platform count includes a temporary raid floor. */
  settlingRaid?: boolean;
}

export const EMPTY_VIEWER_COUNTS: ViewerCounts = {
  platforms: [],
  total: 0,
  partial: false,
  loaded: false,
};

function isPlatform(v: unknown): v is ChatPlatform {
  return CHAT_PLATFORMS.includes(v as ChatPlatform);
}

/** Wire → typed, dropping anything that isn't a real count. */
export function sanitizeViewerCounts(raw: unknown): ViewerCounts {
  if (!raw || typeof raw !== "object") return { ...EMPTY_VIEWER_COUNTS, loaded: true };
  const body = raw as Record<string, unknown>;
  const seen = new Set<ChatPlatform>();
  const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
    .map((p) => {
      const e = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      if (!isPlatform(e.platform) || seen.has(e.platform)) return null;
      seen.add(e.platform);
      const n = Number(e.viewers);
      const viewers =
        e.viewers === null || !Number.isFinite(n) || n < 0
          ? null
          : Math.floor(n);
      const observedAtMs = Number(e.observedAtMs);
      return {
        platform: e.platform,
        viewers,
        live: Boolean(e.live),
        ...(Number.isFinite(observedAtMs) && observedAtMs > 0
          ? { observedAtMs: Math.floor(observedAtMs) }
          : {}),
      };
    })
    .filter((p): p is PlatformViewers => p !== null);

  // Recompute the total from what survived sanitizing rather than
  // trusting the wire's number — they can only disagree if something
  // upstream is wrong, and the visible sum should match the parts.
  let total = 0;
  let partial = false;
  for (const p of platforms) {
    if (p.viewers === null) partial = true;
    else total += p.viewers;
  }
  return { platforms, total, partial, loaded: true };
}

/**
 * Format a viewer count for a dock-width strip: exact below 10k,
 * one-decimal compact above (12.3K, 1.2M) so the number never
 * reflows the header on a busy stream.
 */
export function formatViewers(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${trim1(n / 1_000)}K`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export interface RaidViewerBoost {
  /** Minimum audience implied by all unreconciled raids on this platform. */
  floor: number;
  expiresAtMs: number;
  /** Recent raid ledger used to reconcile several events as one batch. */
  raids?: Array<{ atMs: number; size: number }>;
}

export type RaidViewerBoosts = Partial<Record<ChatPlatform, RaidViewerBoost>>;

interface ViewerObservation {
  viewers: number;
  observedAtMs: number;
}

type ViewerObservationHistory = Partial<
  Record<ChatPlatform, ViewerObservation[]>
>;

function activeRaidLedger(
  raids: ReadonlyArray<{ atMs: number; size: number }>,
  nowMs: number,
): Array<{ atMs: number; size: number }> {
  return raids.filter(
    (raid) =>
      Number.isFinite(raid.atMs) &&
      raid.atMs + RAID_VIEWER_BOOST_MS > nowMs,
  );
}

function raidLedgerExpiresAt(
  raids: ReadonlyArray<{ atMs: number; size: number }>,
): number {
  return Math.max(...raids.map((raid) => raid.atMs + RAID_VIEWER_BOOST_MS));
}

/**
 * Reconcile every still-live raid against one authoritative observation.
 * Grouping matters: two raid events may reach React after one platform sample
 * already incorporated both. Adding each event to the previous displayed
 * floor would count the second party twice.
 */
function reconciledRaidFloor(
  authoritativeEntry: PlatformViewers | undefined,
  history: ReadonlyArray<ViewerObservation>,
  raids: ReadonlyArray<{ atMs: number; size: number }>,
): number {
  const boundedRaids = raids.filter(
    (raid) =>
      Number.isFinite(raid.atMs) &&
      Number.isSafeInteger(raid.size) &&
      raid.size > 0 &&
      raid.size <= RAID_PARTY_MAX,
  );
  const partyTotal = boundedRaids.reduce((sum, raid) => sum + raid.size, 0);
  const authoritative = authoritativeEntry?.viewers;
  if (authoritative === null || authoritative === undefined) {
    return Math.min(RAID_PARTY_MAX, partyTotal);
  }

  const observedAtMs = authoritativeEntry?.observedAtMs;
  if (observedAtMs === undefined) {
    // Backward-compatible rollout posture for an older API response: without
    // timing metadata the last known count is the only usable pre-raid base.
    return Math.min(RAID_PARTY_MAX, authoritative + partyTotal);
  }

  const afterObservation = boundedRaids.filter(
    (raid) => raid.atMs > observedAtMs,
  );
  const afterTotal = afterObservation.reduce((sum, raid) => sum + raid.size, 0);
  const observedRaids = boundedRaids.filter(
    (raid) => raid.atMs <= observedAtMs,
  );
  let observedFloor = authoritative;
  if (observedRaids.length > 0) {
    const earliestRaidAtMs = Math.min(
      ...observedRaids.map((raid) => raid.atMs),
    );
    const preRaid = [...history]
      .reverse()
      .find((observation) => observation.observedAtMs < earliestRaidAtMs);
    if (preRaid) {
      const partiesSinceBaseline = observedRaids
        .filter((raid) => raid.atMs > preRaid.observedAtMs)
        .reduce((sum, raid) => sum + raid.size, 0);
      observedFloor = Math.max(
        authoritative,
        preRaid.viewers + partiesSinceBaseline,
      );
    } else {
      // A first viewer request can start before the raid yet complete after it.
      // The API's completion timestamp then looks post-raid even when the
      // returned platform count is still the pre-raid value. With no earlier
      // sample to disambiguate, preserve the realtime party optimistically;
      // the follow-up fetch and hard expiry keep this bounded.
      observedFloor = Math.min(
        RAID_PARTY_MAX,
        authoritative + observedRaids.reduce(
          (sum, raid) => sum + raid.size,
          0,
        ),
      );
    }
  }
  return Math.min(RAID_PARTY_MAX, observedFloor + afterTotal);
}

/**
 * Extract the incoming party size from every normalized raid/host variant.
 * Twitch raid USERNOTICE and Kick StreamHostEvent both populate `amount`; the
 * detail fallback keeps legacy/test normalized events useful too.
 */
export function raidPartySize(event: ChatEvent): number | null {
  if (event.kind !== "raid") return null;
  const normalizedAmount = String(event.amount ?? "").trim();
  // A present amount is the normalized transport field and therefore wins,
  // even when invalid. Falling back to contradictory prose would turn a
  // malformed `amount: "0"` into a fabricated audience jump.
  const candidates = normalizedAmount
    ? [normalizedAmount]
    : [
        String(event.detail ?? "").match(
          /(?:with|party(?:\s+of)?|hosting\s+with)\s+([\d,\s]+)\s+(?:viewers?|raiders?)/i,
        )?.[1] ?? "",
      ];
  for (const candidate of candidates) {
    const compact = candidate.replace(/[\s,]/g, "");
    if (!/^\d+$/.test(compact)) continue;
    const n = Number(compact);
    if (Number.isSafeInteger(n) && n > 0 && n <= RAID_PARTY_MAX) return n;
  }
  return null;
}

/**
 * Overlay temporary raid floors on an authoritative snapshot. `max`, rather
 * than addition on every render, is the important reconciliation rule: once
 * the platform reaches the floor, the raid is not double-counted.
 */
export function applyRaidViewerBoosts(
  counts: ViewerCounts,
  boosts: RaidViewerBoosts,
  nowMs: number = Date.now(),
): ViewerCounts {
  const active = new Map<ChatPlatform, RaidViewerBoost>();
  for (const platform of CHAT_PLATFORMS) {
    const boost = boosts[platform];
    if (boost && boost.expiresAtMs > nowMs) active.set(platform, boost);
  }
  if (active.size === 0) return counts;

  let partial = counts.partial;
  let settlingRaid = false;
  const present = new Set<ChatPlatform>();
  const platforms = counts.platforms.map((platform) => {
    present.add(platform.platform);
    const boost = active.get(platform.platform);
    if (!boost) return platform;
    const authoritative = platform.viewers;
    if (authoritative !== null && authoritative >= boost.floor) return platform;
    settlingRaid = true;
    if (authoritative === null) partial = true;
    return {
      ...platform,
      viewers: boost.floor,
      live: true,
      raidAdjusted: true,
    };
  });

  // Normally every configured platform is present in the API response. If an
  // upstream returned a malformed/empty list, a realtime raid is still useful
  // as a truthful minimum — mark the aggregate partial instead of pretending
  // the party size is a complete platform count.
  for (const [platform, boost] of active) {
    if (present.has(platform)) continue;
    settlingRaid = true;
    partial = true;
    platforms.push({
      platform,
      viewers: boost.floor,
      live: true,
      raidAdjusted: true,
    });
  }

  if (!settlingRaid) return counts;
  const total = platforms.reduce(
    (sum, platform) => sum + (platform.viewers ?? 0),
    0,
  );
  return { ...counts, platforms, total, partial, settlingRaid: true };
}

/** Live viewer counts for one overlay token. */
export function useViewerCounts(
  token: string,
  events: ReadonlyArray<ChatEvent> = [],
): ViewerCounts {
  const [counts, setCounts] = useState<ViewerCounts>(EMPTY_VIEWER_COUNTS);
  const [raidBoosts, setRaidBoosts] = useState<RaidViewerBoosts>({});
  const countsRef = useRef(counts);
  countsRef.current = counts;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const seenRaidsRef = useRef(new Set<string>());
  const lastTokenRef = useRef<string | null>(null);
  const observationHistoryRef = useRef<ViewerObservationHistory>({});
  const loadRef = useRef<() => void>(() => undefined);
  const raidRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    // Never carry one overlay token's audience into another token
    // while the new request is loading.
    setCounts(EMPTY_VIEWER_COUNTS);
    setRaidBoosts({});
    observationHistoryRef.current = {};
    if (lastTokenRef.current === null) {
      seenRaidsRef.current.clear();
    } else if (lastTokenRef.current !== token) {
      // useMultiChat can retain rows for a render while its engines switch.
      // Adopt those existing ids so a raid from the old token cannot jump the
      // new token's audience.
      seenRaidsRef.current = new Set(
        eventsRef.current
          .filter((event) => event.kind === "raid")
          .map(chatEventIdentity),
      );
    }
    lastTokenRef.current = token;
    if (raidRefreshTimerRef.current) {
      clearTimeout(raidRefreshTimerRef.current);
      raidRefreshTimerRef.current = null;
    }
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const request = ++latestRequest;
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/viewers`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled || request !== latestRequest) return;
        const body: unknown = await res.json();
        // Visibility changes can start a fresh request before an older
        // one finishes. Only the newest snapshot may reach the dock;
        // otherwise a slow, larger response can replace a newer count.
        if (cancelled || request !== latestRequest) return;
        const next = sanitizeViewerCounts(body);
        for (const entry of next.platforms) {
          if (entry.viewers === null || entry.observedAtMs === undefined) continue;
          const history = observationHistoryRef.current[entry.platform] ?? [];
          const observation = {
            viewers: entry.viewers,
            observedAtMs: entry.observedAtMs,
          };
          if (history.at(-1)?.observedAtMs === entry.observedAtMs) {
            history[history.length - 1] = observation;
          } else {
            history.push(observation);
            if (history.length > 4) history.splice(0, history.length - 4);
          }
          observationHistoryRef.current[entry.platform] = history;
        }
        setCounts(next);
      } catch {
        // Transient — keep showing the last good numbers and retry on
        // the next tick rather than blanking a working strip.
      }
    };
    loadRef.current = () => void load();
    void load();
    const timer = setInterval(load, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      latestRequest += 1;
      loadRef.current = () => undefined;
      if (raidRefreshTimerRef.current) {
        clearTimeout(raidRefreshTimerRef.current);
        raidRefreshTimerRef.current = null;
      }
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [token]);

  // Convert each new realtime raid/host into one platform floor. Seen ids are
  // permanent for this token, so reconnect duplicates and React rerenders can
  // never add the same party twice.
  useEffect(() => {
    const nowMs = Date.now();
    const raids: Array<{ event: ChatEvent; size: number }> = [];
    for (const event of events) {
      if (event.kind !== "raid") continue;
      const identity = chatEventIdentity(event);
      if (seenRaidsRef.current.has(identity)) continue;
      while (seenRaidsRef.current.size >= RAID_SEEN_MAX) {
        const oldest = seenRaidsRef.current.values().next().value;
        if (typeof oldest !== "string") break;
        seenRaidsRef.current.delete(oldest);
      }
      seenRaidsRef.current.add(identity);
      const size = raidPartySize(event);
      const ageMs = nowMs - Number(event.atMs);
      if (
        size === null ||
        event.replayed ||
        !Number.isFinite(ageMs) ||
        ageMs > RAID_EVENT_MAX_AGE_MS ||
        ageMs < -RAID_EVENT_MAX_AGE_MS
      ) continue;
      raids.push({ event, size });
    }
    if (raids.length === 0) return;

    setRaidBoosts((previous) => {
      const next = { ...previous };
      const grouped = new Map<
        ChatPlatform,
        Array<{ atMs: number; size: number }>
      >();
      for (const { event, size } of raids) {
        const group = grouped.get(event.platform) ?? [];
        group.push({ atMs: event.atMs, size });
        grouped.set(event.platform, group);
      }
      for (const [platform, newRaids] of grouped) {
        const existing = next[platform];
        const priorRaids = activeRaidLedger(existing?.raids ?? [], nowMs);
        const combinedRaids = [...priorRaids, ...newRaids];
        const authoritativeEntry = countsRef.current.platforms.find(
          (entry) => entry.platform === platform,
        );
        const history = observationHistoryRef.current[platform] ?? [];
        const legacyAdditionalParty = newRaids.reduce(
          (sum, raid) => sum + raid.size,
          0,
        );
        const keptEveryPriorRaid =
          priorRaids.length === (existing?.raids?.length ?? 0);
        const floor =
          authoritativeEntry?.observedAtMs === undefined &&
          existing &&
          keptEveryPriorRaid
            ? Math.min(
                RAID_PARTY_MAX,
                existing.floor + legacyAdditionalParty,
              )
            : reconciledRaidFloor(
                authoritativeEntry,
                history,
                combinedRaids,
              );
        next[platform] = {
          floor,
          expiresAtMs: raidLedgerExpiresAt(combinedRaids),
          raids: combinedRaids,
        };
      }
      return next;
    });

    // The optimistic floor is immediate. Refresh now in case the server cache
    // already rolled, then once more just beyond its normal 20-second TTL.
    loadRef.current();
    if (raidRefreshTimerRef.current) clearTimeout(raidRefreshTimerRef.current);
    raidRefreshTimerRef.current = setTimeout(() => {
      raidRefreshTimerRef.current = null;
      loadRef.current();
    }, RAID_REFRESH_DELAY_MS);
  }, [events, token]);

  // Drop a boost invisibly once the platform reaches it. If viewer churn means
  // it never does, the expiry effect below restores the official count.
  useEffect(() => {
    setRaidBoosts((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const platform of CHAT_PLATFORMS) {
        const boost = next[platform];
        if (!boost) continue;
        const authoritativeEntry = counts.platforms.find(
          (entry) => entry.platform === platform,
        );
        const authoritative = authoritativeEntry?.viewers;
        const nowMs = Date.now();
        const hadRaidLedger = boost.raids !== undefined;
        const raids = activeRaidLedger(boost.raids ?? [], nowMs);
        const raidLedgerChanged = raids.length !== (boost.raids?.length ?? 0);
        if (hadRaidLedger && raids.length === 0) {
          delete next[platform];
          changed = true;
          continue;
        }
        const floor =
          raids.length > 0 &&
          (
            authoritativeEntry?.observedAtMs !== undefined ||
            raidLedgerChanged
          )
            ? reconciledRaidFloor(
                authoritativeEntry,
                observationHistoryRef.current[platform] ?? [],
                raids,
              )
            : boost.floor;
        const expiresAtMs = raids.length > 0
          ? raidLedgerExpiresAt(raids)
          : boost.expiresAtMs;
        if (authoritative !== null && authoritative !== undefined &&
            authoritative >= floor) {
          delete next[platform];
          changed = true;
        } else if (
          floor !== boost.floor ||
          expiresAtMs !== boost.expiresAtMs ||
          raidLedgerChanged
        ) {
          next[platform] = {
            ...boost,
            floor,
            expiresAtMs,
            ...(hadRaidLedger ? { raids } : {}),
          };
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [counts]);

  // Expiration needs its own wake-up; otherwise a quiet dock could keep the
  // temporary number rendered until the next 45-second poll.
  useEffect(() => {
    const expiries = Object.values(raidBoosts)
      .filter((boost): boost is RaidViewerBoost => Boolean(boost))
      .map((boost) => {
        const raids = boost.raids ?? [];
        return raids.length > 0
          ? Math.min(
              ...raids.map((raid) => raid.atMs + RAID_VIEWER_BOOST_MS),
            )
          : boost.expiresAtMs;
      });
    if (expiries.length === 0) return;
    const delay = Math.max(0, Math.min(...expiries) - Date.now());
    const timer = setTimeout(() => {
      const nowMs = Date.now();
      setRaidBoosts((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const platform of CHAT_PLATFORMS) {
          const boost = next[platform];
          if (!boost) continue;
          const hadRaidLedger = boost.raids !== undefined;
          const raids = activeRaidLedger(boost.raids ?? [], nowMs);
          if (
            (!hadRaidLedger && boost.expiresAtMs <= nowMs) ||
            (hadRaidLedger && raids.length === 0)
          ) {
            delete next[platform];
            changed = true;
            continue;
          }
          if (hadRaidLedger && raids.length !== boost.raids?.length) {
            const authoritativeEntry = countsRef.current.platforms.find(
              (entry) => entry.platform === platform,
            );
            next[platform] = {
              ...boost,
              floor: reconciledRaidFloor(
                authoritativeEntry,
                observationHistoryRef.current[platform] ?? [],
                raids,
              ),
              expiresAtMs: raidLedgerExpiresAt(raids),
              raids,
            };
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }, delay + 1);
    return () => clearTimeout(timer);
  }, [raidBoosts]);

  return applyRaidViewerBoosts(counts, raidBoosts);
}
