"use client";

import { useEffect, useRef } from "react";

const FIRST_CHECK_MS = 15_000;
const CHECK_INTERVAL_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const RELOAD_COOLDOWN_MS = 10 * 60_000;
const RELOAD_STAMP_KEY = "sc2tools.overlay-build-reload-at";
const RELOAD_QUERY_KEY = "_sc2tools_build_reload";
const NEXT_CHUNK_MARKER = "/_next/static/chunks/";
const NEXT_CSS_MARKER = "/_next/static/css/";
const CONTENT_HASH_RE = /-[0-9a-f]{8,}(?=\.js$)/i;

/**
 * OBS keeps Browser Sources alive when `shutdown` / `restart_when_active` are
 * disabled. A source can therefore keep executing a pre-deploy JavaScript
 * bundle indefinitely even though its route is force-dynamic and no-store.
 *
 * Capture the hashed Next.js JavaScript and CSS loaded by the running
 * document. A later no-store fetch of the same HTML exposes the assets for the
 * current deploy; changed hashes prove this Chromium instance is stale without
 * requiring a separate version service.
 */
export function captureOverlayBuildAssets(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("script[src], link[href]"))
    .map((element) =>
      normalizeAssetPath(
        element.getAttribute(element.tagName === "SCRIPT" ? "src" : "href"),
      ),
    )
    .filter((asset): asset is string => asset !== null);
}

/** Extract the same deployment assets from freshly-fetched route HTML. */
export function extractOverlayBuildAssets(html: string): string[] {
  if (typeof html !== "string" || !html) return [];
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return captureOverlayBuildAssets(parsed);
}

/**
 * Compare only logical chunks present in both pages. Runtime-loaded scripts
 * may add current-only entries and a new deploy may split an unrelated chunk;
 * neither is proof that this overlay's code changed. The route chunk itself
 * always shares a logical name, so relevant deploys remain detectable.
 */
export function overlayBuildChanged(
  currentAssets: readonly string[],
  latestAssets: readonly string[],
): boolean {
  const currentCss = new Set(
    currentAssets.filter((asset) => asset.endsWith(".css")),
  );
  // Production CSS filenames can be pure content hashes with no stable
  // logical prefix. A new stylesheet referenced by the fresh route HTML is
  // therefore direct proof of a deploy; current-only runtime styles are not.
  if (
    latestAssets.some(
      (asset) => asset.endsWith(".css") && !currentCss.has(asset),
    )
  ) return true;

  const currentByLogicalName = logicalAssetMap(currentAssets);
  const latestByLogicalName = logicalAssetMap(latestAssets);
  for (const [logicalName, latestPath] of latestByLogicalName) {
    const currentPath = currentByLogicalName.get(logicalName);
    if (currentPath && currentPath !== latestPath) return true;
  }
  return false;
}

/**
 * Stamp the runtime URL as a reload-surviving cooldown fallback. OBS can deny
 * web storage, while a query parameter survives the navigation itself and is
 * ignored by the overlay route.
 */
export function overlayReloadUrl(href: string, nowMs: number): string {
  const url = new URL(href);
  url.searchParams.set(RELOAD_QUERY_KEY, String(Math.floor(nowMs)));
  return url.toString();
}

export function overlayReloadOnCooldown(
  search: string,
  storedAt: string | null,
  nowMs: number,
): boolean {
  const queryAt = Number(new URLSearchParams(search).get(RELOAD_QUERY_KEY));
  const storageAt = Number(storedAt);
  const lastReload = Math.max(
    Number.isFinite(queryAt) ? queryAt : 0,
    Number.isFinite(storageAt) ? storageAt : 0,
  );
  return lastReload > 0 && nowMs - lastReload < RELOAD_COOLDOWN_MS;
}

/**
 * A React state update that marks a feed quiet lands one commit after the
 * message/event prop that invalidates it. Comparing the current tail with the
 * tail that actually completed the quiet window closes that same-commit gap.
 */
export function overlayFeedTailIsQuiet(
  quietWindowComplete: boolean,
  currentTailIdentity: string,
  quietConfirmedTailIdentity: string | null,
): boolean {
  return (
    quietWindowComplete
    && quietConfirmedTailIdentity === currentTailIdentity
  );
}

/**
 * Quietly self-heal long-lived OBS sources after a web deployment.
 *
 * A change found during BRB / Starting Soon is remembered, then applied once
 * the Dock returns Live so an update never blanks an active break scene.
 */
export function useOverlayBuildRefresh({
  enabled,
  safeToReload,
  replaceLocation,
}: {
  enabled: boolean;
  safeToReload: boolean;
  /** Dependency seam for non-navigating lifecycle tests. */
  replaceLocation?: (href: string) => void;
}) {
  const safeToReloadRef = useRef(safeToReload);
  const pendingReloadRef = useRef(false);
  const reloadRequestedRef = useRef(false);
  const requestReloadRef = useRef<() => void>(() => undefined);
  safeToReloadRef.current = safeToReload;
  requestReloadRef.current = () => {
    if (reloadRequestedRef.current) return;
    const now = Date.now();
    const storageKey = `${RELOAD_STAMP_KEY}:${window.location.pathname}:${window.innerWidth}x${window.innerHeight}`;
    let storedAt: string | null = null;
    try {
      storedAt = sessionStorage.getItem(storageKey);
    } catch {
      // The stamped URL below remains available when storage is denied.
    }
    if (overlayReloadOnCooldown(window.location.search, storedAt, now)) return;
    try {
      sessionStorage.setItem(storageKey, String(now));
    } catch {
      // Query stamping is the reload-surviving fallback.
    }
    reloadRequestedRef.current = true;
    const nextUrl = overlayReloadUrl(window.location.href, now);
    if (replaceLocation) replaceLocation(nextUrl);
    else window.location.replace(nextUrl);
  };

  useEffect(() => {
    if (!enabled || !safeToReload || !pendingReloadRef.current) return;
    requestReloadRef.current();
  }, [enabled, safeToReload]);

  useEffect(() => {
    if (!enabled) return;
    const currentAssets = captureOverlayBuildAssets(document);
    if (currentAssets.length === 0) return;

    let disposed = false;
    let inFlight = false;
    let interval: number | null = null;
    let cancelInFlight: (() => void) | null = null;
    const check = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      let guardFinished = false;
      let rejectGuard: (reason: Error) => void = () => undefined;
      const guard = new Promise<never>((_resolve, reject) => {
        rejectGuard = reject;
      });
      const abort = () => {
        if (guardFinished) return;
        guardFinished = true;
        controller.abort();
        rejectGuard(abortError());
      };
      cancelInFlight = abort;
      const timeout = window.setTimeout(abort, FETCH_TIMEOUT_MS);
      try {
        const response = await Promise.race([
          fetch(window.location.href, {
            cache: "no-store",
            headers: { accept: "text/html" },
            signal: controller.signal,
          }),
          guard,
        ]);
        if (disposed) return;
        if (!response.ok) return;
        const html = await Promise.race([response.text(), guard]);
        if (disposed) return;
        const latestAssets = extractOverlayBuildAssets(html);
        if (!overlayBuildChanged(currentAssets, latestAssets)) return;
        pendingReloadRef.current = true;
        if (safeToReloadRef.current) requestReloadRef.current();
      } catch {
        // A failed version check has no broadcast impact; the next tick retries.
      } finally {
        guardFinished = true;
        window.clearTimeout(timeout);
        if (cancelInFlight === abort) cancelInFlight = null;
        inFlight = false;
      }
    };

    const firstCheck = window.setTimeout(() => {
      void check();
      interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    }, FIRST_CHECK_MS);

    return () => {
      disposed = true;
      cancelInFlight?.();
      cancelInFlight = null;
      window.clearTimeout(firstCheck);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [enabled]);
}

function normalizeAssetPath(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const path = new URL(raw, "https://overlay.invalid").pathname;
    return (
      (path.includes(NEXT_CHUNK_MARKER) && path.endsWith(".js"))
      || (path.includes(NEXT_CSS_MARKER) && path.endsWith(".css"))
    )
      ? path
      : null;
  } catch {
    return null;
  }
}

function logicalAssetMap(assets: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const path of assets) {
    if (!path.endsWith(".js")) continue;
    result.set(path.replace(CONTENT_HASH_RE, "-[build]"), path);
  }
  return result;
}

function abortError(): Error {
  const error = new Error("Overlay build check aborted");
  error.name = "AbortError";
  return error;
}
