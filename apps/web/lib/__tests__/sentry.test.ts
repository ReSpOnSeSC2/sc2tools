import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ calls: [] as string[], options: null as Record<string, unknown> | null }));
vi.mock("@sentry/nextjs", () => ({
  init: (options: Record<string, unknown>) => { sdk.calls.push("init"); sdk.options = options; },
  captureException: () => { sdk.calls.push("capture"); return "event-1"; },
}));

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllEnvs(); vi.resetModules(); sdk.calls.length = 0; sdk.options = null;
});

describe("browser Sentry", () => {
  it.each(["/wrapped", "/career", "/card/report/summary#LocalData", "/card/r%65port/%73ummary#LocalData", "/b/opening", "/%62/opening",
    "/match/%72oom#r=private"])("does not initialize or report errors on %s", async pathname => {
    window.history.replaceState(null, "", pathname);
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { captureException, initClientSentry } = await import("../sentry");
    await initClientSentry();
    expect(await captureException(new Error("local recap error"))).toBeNull();
    expect(sdk.calls).toEqual([]);
  });

  it.each(["/wrapped", "/career", "/card/report/summary#LocalData", "/card/r%65port/%73ummary#LocalData", "/b/opening",
    "/match/room#r=private"])("drops events and breadcrumbs after navigating to %s", async pathname => {
    window.history.replaceState(null, "", "/help");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { initClientSentry } = await import("../sentry");
    await initClientSentry();
    window.history.replaceState(null, "", pathname);
    for (const key of ["beforeBreadcrumb", "beforeSend", "beforeSendTransaction"]) {
      const hook = sdk.options?.[key];
      expect(typeof hook === "function" ? hook({}) : undefined).toBeNull();
    }
  });

  it("initializes with the request-URL scrubbers before any capture, even one that comes first", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { captureException, initClientSentry } = await import("../sentry");
    const eventId = captureException(new Error("boom"));
    void initClientSentry();
    expect(await eventId).toBe("event-1");
    expect(sdk.calls).toEqual(["init", "capture"]);
    expect(sdk.options).toMatchObject({ beforeBreadcrumb: expect.any(Function), beforeSendSpan: expect.any(Function),
      beforeSendTransaction: expect.any(Function) });
  });

  it("scrubs opponent filters from the SDK's error URL and referrer", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { initClientSentry } = await import("../sentry");
    await initClientSentry();
    const hook = sdk.options?.beforeSend;
    const url = "https://sc2tools.com/app/opponents?opponentFilter=Fixture+Rival";
    const referer = "https://sc2tools.com/app/opponents?q=Legacy";
    const event = { request: { url, headers: { Referer: referer, "User-Agent": "Fixture browser" } } };
    expect(typeof hook === "function" ? hook(event) : undefined).toEqual({
      request: { url: "/app/opponents", headers: { Referer: "/app/opponents", "User-Agent": "Fixture browser" } },
    });
    expect(event.request).toEqual({ url, headers: { Referer: referer, "User-Agent": "Fixture browser" } });
    const neighboring = { request: { url: "/app/replays?q=keep", headers: { referer: "/app/help?q=keep" } } };
    expect(typeof hook === "function" ? hook(neighboring) : undefined).toEqual(neighboring);
  });

  it("stays off, with the error on the console, when the scrubber chunk fails to load", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    vi.doMock("../sentryPrivacy", () => { throw new Error("ChunkLoadError"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureException, initClientSentry } = await import("../sentry");
    await initClientSentry();
    expect(await captureException(new Error("boom"))).toBeNull();
    expect(sdk.calls).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore(); vi.doUnmock("../sentryPrivacy");
  });

  it("reports nothing and loads nothing without a DSN", async () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { captureException, initClientSentry } = await import("../sentry");
    await initClientSentry();
    expect(await captureException(new Error("boom"))).toBeNull();
    expect(sdk.calls).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});
