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
  it("does not initialize or report errors on the local year recap", async () => {
    window.history.replaceState(null, "", "/wrapped");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { captureException, initClientSentry } = await import("../sentry");
    await initClientSentry();
    expect(await captureException(new Error("local recap error"))).toBeNull();
    expect(sdk.calls).toEqual([]);
  });

  it("drops local recap events and breadcrumbs after client-side navigation", async () => {
    window.history.replaceState(null, "", "/help");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
    const { initClientSentry } = await import("../sentry");
    await initClientSentry();
    window.history.replaceState(null, "", "/wrapped");
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
