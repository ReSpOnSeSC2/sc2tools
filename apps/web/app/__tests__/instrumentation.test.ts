import { afterEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ init: vi.fn(), captureRequestError: vi.fn() }));
vi.mock("@sentry/nextjs", () => sdk);

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it("drops Match Room OBS server telemetry while preserving other requests", async () => {
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "https://public@example.ingest/1");
  const { onRequestError, register } = await import("../../instrumentation");
  await register();
  expect(sdk.init).toHaveBeenCalledOnce();
  const hooks = sdk.init.mock.calls[0]?.[0];
  const source = { request: { url: "/overlay/%6datch-room?credit=0#r=locator" } };
  const transaction = { transaction: "GET /overlay/match-room" };
  const other = { request: { url: "/overlay/another-token" } };
  expect(hooks.beforeSend(source)).toBeNull();
  expect(hooks.beforeSendTransaction(transaction)).toBeNull();
  expect(hooks.beforeSend(other)).toEqual(other);
  const error = new Error("test");
  await onRequestError(error, { path: "/overlay/match-room" });
  await onRequestError(error, { path: "/help" });
  expect(sdk.captureRequestError.mock.calls).toEqual([[error, { path: "/help" }]]);
});
