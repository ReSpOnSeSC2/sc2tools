import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPublicReachability, publicApiPingUrl, STATUS_CHECK_TIMEOUT_MS } from "./reachability";

const fetcher = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => { fetcher.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("fixed public API endpoint configuration", () => {
  it("uses the existing configured HTTPS API base and strips trailing slashes", () => {
    expect(publicApiPingUrl("https://api.sc2tools.test/", "https://sc2tools.com")).toBe("https://api.sc2tools.test/v1/ping");
    expect(publicApiPingUrl("https://api.sc2tools.test/base///", "https://sc2tools.com")).toBe("https://api.sc2tools.test/base/v1/ping");
  });
  it.each([undefined, "", "invalid", "http://api.sc2tools.test", "https://user:secret@api.sc2tools.test", "https://api.sc2tools.test/?token=secret", "https://api.sc2tools.test/#fragment", "https://localhost:8080", "https://localhost.:8080", "https://127.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[::]", "https://0.0.0.0", "http://localhost:8080"])("fails closed for missing/invalid/loopback production config %s", value => {
    expect(publicApiPingUrl(value, "https://sc2tools.com")).toBeNull();
  });
  it("permits HTTP loopback only from a local website context", () => {
    expect(publicApiPingUrl(undefined, "http://localhost:3000")).toBe("http://localhost:8080/v1/ping");
    expect(publicApiPingUrl("http://127.0.0.1:8080/", "http://localhost:3000")).toBe("http://127.0.0.1:8080/v1/ping");
    expect(publicApiPingUrl("http://api.sc2tools.test", "http://localhost:3000")).toBeNull();
  });
});

describe("browser reachability probes", () => {
  it("requires HTTP success and status ok JSON and omits all credentials", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "ok", time: "untrusted remote timestamp" })));
    const result = await checkPublicReachability("/api/ping", new AbortController().signal);
    expect(result).toMatchObject({ state: "reachable" });
    expect(Number.isFinite(Date.parse(result.checkedAt!))).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/ping", expect.objectContaining({
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", headers: { accept: "application/json" },
    }));
  });
  it("reports actual HTTP errors without trusting a successful-looking error body", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ status: "ok", privateDiagnostic: "never display" }), { status: 503 }));
    const result = await checkPublicReachability("/api/ping", new AbortController().signal);
    expect(result).toMatchObject({ state: "unavailable", message: "The service responded with HTTP 503. Try again shortly." });
    expect(result.message).not.toContain("never display");
  });
  it.each(["null", "[]", "{}", '{"status":"degraded"}', '"ok"', "<html>private stack trace</html>"])("does not call an unexpected payload reachable: %s", async body => {
    fetcher.mockResolvedValue(new Response(body));
    const result = await checkPublicReachability("/api/ping", new AbortController().signal);
    expect(result.state).toBe("unknown"); expect(result.message).toContain("unexpected response");
    expect(result.message).not.toContain("private stack trace");
  });
  it("keeps browser/network failures distinct from a confirmed service outage", async () => {
    fetcher.mockRejectedValue(new TypeError("sensitive proxy diagnostic"));
    const result = await checkPublicReachability("/api/ping", new AbortController().signal);
    expect(result.state).toBe("unknown"); expect(result.message).toContain("browser access rules");
    expect(result.message).not.toContain("sensitive");
  });
  it("returns unknown without a request when no safe API endpoint is configured", async () => {
    expect(await checkPublicReachability(null, new AbortController().signal)).toMatchObject({ state: "unknown" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["headers", "body"])("bounds stalled %s even when the adapter ignores abort", async stage => {
    vi.useFakeTimers();
    const headers = deferred<Response>(), body = deferred<unknown>();
    fetcher.mockImplementation((_url, init: RequestInit) => stage === "headers" ? headers.promise : Promise.resolve({ ok: true, json: () => body.promise, signal: init.signal }));
    const pending = checkPublicReachability("/api/ping", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(STATUS_CHECK_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ state: "unknown", message: "No response within 4 seconds. Try refreshing the checks." });
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    headers.resolve(new Response('{"status":"ok"}')); body.resolve({ status: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("settles a retired check immediately and cancels its timer and fetch", async () => {
    vi.useFakeTimers(); fetcher.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = checkPublicReachability("/api/ping", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});
