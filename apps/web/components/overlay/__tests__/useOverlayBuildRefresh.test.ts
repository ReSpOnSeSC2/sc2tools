import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureOverlayBuildAssets,
  extractOverlayBuildAssets,
  overlayFeedTailIsQuiet,
  overlayBuildChanged,
  overlayReloadOnCooldown,
  overlayReloadUrl,
  useOverlayBuildRefresh,
} from "../useOverlayBuildRefresh";

const FIRST_CHECK_MS = 15_000;
const CHECK_INTERVAL_MS = 2 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const CLOCK_START_MS = 2_000_000;
const CURRENT_JS = "/_next/static/chunks/5637-aaaaaaaaaaaaaaaa.js";
const LATEST_JS = "/_next/static/chunks/5637-cccccccccccccccc.js";
const CURRENT_CSS = "/_next/static/css/aaaaaaaaaaaaaaaa.css";
const LATEST_CSS = "/_next/static/css/bbbbbbbbbbbbbbbb.css";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(CLOCK_START_MS);
  window.history.replaceState(
    {},
    "",
    "/overlay/token/scene/manual?audio=1",
  );
  window.sessionStorage.clear();
  installCurrentAssets();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("overlay deployment refresh detection", () => {
  it("extracts hashed Next.js JavaScript and CSS assets", () => {
    document.head.innerHTML = `
      <script src="/_next/static/chunks/5637-aaaaaaaaaaaaaaaa.js"></script>
      <link rel="stylesheet" href="/_next/static/css/aaaaaaaaaaaaaaaa.css" />
      <script src="https://sc2tools.com/_next/static/chunks/app/overlay/%5Btoken%5D/scene/%5Bname%5D/page-bbbbbbbbbbbbbbbb.js"></script>
      <link rel="stylesheet" href="/plain.css" />
      <script src="https://www.youtube.com/iframe_api"></script>
    `;

    expect(captureOverlayBuildAssets(document)).toEqual([
      "/_next/static/chunks/5637-aaaaaaaaaaaaaaaa.js",
      "/_next/static/css/aaaaaaaaaaaaaaaa.css",
      "/_next/static/chunks/app/overlay/%5Btoken%5D/scene/%5Bname%5D/page-bbbbbbbbbbbbbbbb.js",
    ]);
    expect(
      extractOverlayBuildAssets(`
        <script src="/_next/static/chunks/5637-cccccccccccccccc.js"></script>
        <link href='/_next/static/css/bbbbbbbbbbbbbbbb.css' rel='stylesheet'>
        <script src="/plain.js"></script>
      `),
    ).toEqual([
      "/_next/static/chunks/5637-cccccccccccccccc.js",
      "/_next/static/css/bbbbbbbbbbbbbbbb.css",
    ]);
  });

  it("detects changed route and shared chunk revisions", () => {
    const current = [
      "/_next/static/chunks/5637-aaaaaaaaaaaaaaaa.js",
      "/_next/static/chunks/app/overlay/%5Btoken%5D/scene/%5Bname%5D/page-bbbbbbbbbbbbbbbb.js",
    ];
    expect(
      overlayBuildChanged(current, [
        "/_next/static/chunks/5637-cccccccccccccccc.js",
        current[1],
      ]),
    ).toBe(true);
    expect(
      overlayBuildChanged(current, [
        current[0],
        "/_next/static/chunks/app/overlay/%5Btoken%5D/scene/%5Bname%5D/page-dddddddddddddddd.js",
      ]),
    ).toBe(true);
    expect(overlayBuildChanged([CURRENT_CSS], [LATEST_CSS])).toBe(true);
  });

  it("does not reload for identical or unrelated runtime chunk lists", () => {
    const route =
      "/_next/static/chunks/app/overlay/%5Btoken%5D/widget/%5Bname%5D/page-aaaaaaaaaaaaaaaa.js";
    expect(overlayBuildChanged([route], [route])).toBe(false);
    expect(
      overlayBuildChanged(
        [route, "/_next/static/chunks/9999-bbbbbbbbbbbbbbbb.js"],
        [route, "/_next/static/chunks/1234-cccccccccccccccc.js"],
      ),
    ).toBe(false);
    expect(
      overlayBuildChanged(
        [CURRENT_CSS, "/_next/static/css/runtime-only.css"],
        [CURRENT_CSS],
      ),
    ).toBe(false);
  });

  it("uses a stamped URL as a cooldown when OBS storage is unavailable", () => {
    const nowMs = 2_000_000;
    const stamped = overlayReloadUrl(
      "https://sc2tools.com/overlay/token/scene/manual?audio=1",
      nowMs,
    );
    const url = new URL(stamped);

    expect(url.searchParams.get("audio")).toBe("1");
    expect(overlayReloadOnCooldown(url.search, null, nowMs + 15_000)).toBe(true);
    expect(
      overlayReloadOnCooldown(url.search, null, nowMs + 10 * 60_000),
    ).toBe(false);
  });

  it("also honors a newer session cooldown without a query stamp", () => {
    expect(overlayReloadOnCooldown("?audio=0", "3000000", 3_001_000)).toBe(
      true,
    );
  });

  it("blocks a pending build reload in the same commit as a feed arrival", () => {
    expect(overlayFeedTailIsQuiet(true, "message:new", "message:old")).toBe(
      false,
    );
    expect(overlayFeedTailIsQuiet(true, "message:new", "message:new")).toBe(
      true,
    );
  });

  it("starts its first no-store build check from the timer", async () => {
    fetchMock.mockResolvedValue(htmlResponse(routeHtml()));
    const replaceLocation = vi.fn();
    renderHook(() =>
      useOverlayBuildRefresh({
        enabled: true,
        safeToReload: true,
        replaceLocation,
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await advanceBy(FIRST_CHECK_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await advanceBy(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      window.location.href,
      expect.objectContaining({
        cache: "no-store",
        headers: { accept: "text/html" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("defers a stale-build navigation until safeToReload becomes true", async () => {
    fetchMock.mockResolvedValue(htmlResponse(routeHtml({ css: LATEST_CSS })));
    const replaceLocation = vi.fn();
    const view = renderHook(
      ({ safeToReload }) =>
        useOverlayBuildRefresh({
          enabled: true,
          safeToReload,
          replaceLocation,
        }),
      { initialProps: { safeToReload: false } },
    );

    await advanceBy(FIRST_CHECK_MS);
    expect(replaceLocation).not.toHaveBeenCalled();

    view.rerender({ safeToReload: true });
    expect(replaceLocation).toHaveBeenCalledTimes(1);
    const destination = new URL(replaceLocation.mock.calls[0][0]);
    expect(destination.searchParams.get("audio")).toBe("1");
    expect(destination.searchParams.get("_sc2tools_build_reload")).toBe(
      String(Date.now()),
    );
  });

  it("times out a hung fetch and retries on the next interval", async () => {
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>(() => undefined))
      .mockResolvedValueOnce(htmlResponse(routeHtml()));
    renderHook(() =>
      useOverlayBuildRefresh({
        enabled: true,
        safeToReload: true,
        replaceLocation: vi.fn(),
      }),
    );

    await advanceBy(FIRST_CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstSignal = fetchSignalAt(0);
    expect(firstSignal.aborted).toBe(false);

    await advanceBy(FETCH_TIMEOUT_MS);
    expect(firstSignal.aborted).toBe(true);
    await advanceBy(CHECK_INTERVAL_MS - FETCH_TIMEOUT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses its stamped URL to prevent loops when sessionStorage is denied", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    fetchMock.mockResolvedValue(htmlResponse(routeHtml({ js: LATEST_JS })));
    const replaceLocation = vi.fn();
    const first = renderHook(() =>
      useOverlayBuildRefresh({
        enabled: true,
        safeToReload: true,
        replaceLocation,
      }),
    );

    await advanceBy(FIRST_CHECK_MS);
    expect(replaceLocation).toHaveBeenCalledTimes(1);
    const stamped = new URL(replaceLocation.mock.calls[0][0]);
    expect(stamped.searchParams.get("_sc2tools_build_reload")).toBeTruthy();
    first.unmount();

    window.history.replaceState(
      {},
      "",
      `${stamped.pathname}${stamped.search}`,
    );
    replaceLocation.mockClear();
    renderHook(() =>
      useOverlayBuildRefresh({
        enabled: true,
        safeToReload: true,
        replaceLocation,
      }),
    );
    await advanceBy(FIRST_CHECK_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replaceLocation).not.toHaveBeenCalled();
  });

  it("aborts an awaiting fetch on unmount and never navigates afterward", async () => {
    const pendingResponse = deferred<Response>();
    fetchMock.mockImplementation(() => pendingResponse.promise);
    const replaceLocation = vi.fn();
    const view = renderHook(() =>
      useOverlayBuildRefresh({
        enabled: true,
        safeToReload: true,
        replaceLocation,
      }),
    );

    await advanceBy(FIRST_CHECK_MS);
    const signal = fetchSignalAt(0);
    view.unmount();
    expect(signal.aborted).toBe(true);
    pendingResponse.resolve(htmlResponse(routeHtml({ css: LATEST_CSS })));
    await flushMicrotasks();

    expect(replaceLocation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a response body that finishes after the hook is disabled", async () => {
    const pendingBody = deferred<string>();
    const text = vi.fn(() => pendingBody.promise);
    fetchMock.mockImplementation(() => {
      return Promise.resolve({ ok: true, text } as unknown as Response);
    });
    const replaceLocation = vi.fn();
    const view = renderHook(
      ({ enabled }) =>
        useOverlayBuildRefresh({
          enabled,
          safeToReload: true,
          replaceLocation,
        }),
      { initialProps: { enabled: true } },
    );

    await advanceBy(FIRST_CHECK_MS);
    expect(text).toHaveBeenCalledTimes(1);
    const signal = fetchSignalAt(0);
    view.rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    pendingBody.resolve(routeHtml({ css: LATEST_CSS }));
    await flushMicrotasks();

    expect(replaceLocation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function installCurrentAssets() {
  document.head.innerHTML = `
    <script src="${CURRENT_JS}"></script>
    <link rel="stylesheet" href="${CURRENT_CSS}" />
  `;
}

function routeHtml({
  js = CURRENT_JS,
  css = CURRENT_CSS,
}: {
  js?: string;
  css?: string;
} = {}) {
  return `
    <html><head>
      <script src="${js}"></script>
      <link rel="stylesheet" href="${css}" />
    </head><body></body></html>
  `;
}

function htmlResponse(html: string): Response {
  return {
    ok: true,
    text: vi.fn().mockResolvedValue(html),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fetchSignalAt(index: number): AbortSignal {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  const signal = init?.signal;
  if (!(signal instanceof AbortSignal)) {
    throw new Error(`Fetch call ${index} did not receive an AbortSignal`);
  }
  return signal;
}

async function advanceBy(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
