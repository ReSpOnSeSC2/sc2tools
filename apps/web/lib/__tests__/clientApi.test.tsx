import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  auth: {
    getToken: vi.fn(),
    isLoaded: true,
    isSignedIn: true,
    userId: "user-a" as string | null,
  },
  useSWR: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => harness.auth,
}));

vi.mock("swr", () => ({
  default: harness.useSWR,
}));

import { API_BASE, apiCall, useApi } from "../clientApi";

type MockSWRResult = {
  key: readonly [string, string, string] | null;
  fetcher: (key: readonly [string, string, string]) => Promise<unknown>;
};

beforeEach(() => {
  harness.auth.isLoaded = true;
  harness.auth.isSignedIn = true;
  harness.auth.userId = "user-a";
  harness.auth.getToken.mockReset();
  harness.auth.getToken.mockImplementation(async () =>
    harness.auth.userId ? `token-${harness.auth.userId}` : null,
  );
  harness.useSWR.mockReset();
  harness.useSWR.mockImplementation((key, fetcher) => ({ key, fetcher }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("opt-in API deadlines", () => {
  function boundedFetcher(timeoutMs = 1000) {
    const view = renderHook(() => useApi("/v1/admin/global-trends/timeseries", undefined, { timeoutMs }));
    const swr = view.result.current as unknown as MockSWRResult;
    return () => swr.fetcher(swr.key!);
  }

  it("times out a token lookup and never sends the late authenticated request", async () => {
    vi.useFakeTimers();
    let resolveToken!: (token: string) => void;
    harness.auth.getToken.mockReturnValue(new Promise<string>((resolve) => { resolveToken = resolve; }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rejected = expect(boundedFetcher()()).rejects.toMatchObject({ status: 0, code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    resolveToken("late-token");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a stalled fetch and presents a timeout instead of an AbortError", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      requestSignal = init.signal!;
      return new Promise((_resolve, reject) => {
        requestSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const rejected = expect(boundedFetcher()()).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also settles a stalled response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));
    const rejected = expect(boundedFetcher()()).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears successful deadlines and caller abort listeners for explicit requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    await expect(boundedFetcher()()).resolves.toEqual({ ok: true });
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const view = renderHook(() => useApi("/v1/admin/global-trends/timeseries", undefined, { timeoutMs: 1000 }));
    await expect(view.result.current.request({ method: "POST", signal: caller.signal })).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes connection failures only when the caller opts in", async () => {
    vi.useFakeTimers();
    const networkError = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    await expect(boundedFetcher()()).rejects.toMatchObject({ status: 0, code: "network_unavailable", message: expect.stringContaining("API is unavailable") });
    const view = renderHook(() => useApi("/v1/timeseries"));
    const swr = view.result.current as unknown as MockSWRResult;
    await expect(swr.fetcher(swr.key!)).rejects.toBe(networkError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useApi authenticated cache identity", () => {
  it("rejects refresh mutations after sign-out without sending an anonymous request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    harness.auth.isSignedIn = false;
    harness.auth.userId = null;
    const view = renderHook(() => useApi("/v1/private"));
    await expect(view.result.current.request({ method: "POST" })).rejects.toThrow("sign in again");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates the same API path by Clerk user without changing the fetch URL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const view = renderHook(() => useApi<{ ok: boolean }>("/v1/private"));
    const current = () => view.result.current as unknown as MockSWRResult;

    expect(current().key).toEqual([
      "authenticated-api",
      "user-a",
      "/v1/private",
    ]);

    harness.auth.userId = "user-b";
    view.rerender();

    expect(current().key).toEqual([
      "authenticated-api",
      "user-b",
      "/v1/private",
    ]);

    await current().fetcher(current().key!);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/v1/private`, {
      headers: { authorization: "Bearer token-user-b" },
      cache: "no-store",
    });

    harness.auth.isSignedIn = false;
    harness.auth.userId = null;
    view.rerender();
    expect(current().key).toBeNull();
  });
});

describe("client mutation errors", () => {
  it("explains analysis queue limits without exposing server internals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "trends_busy", message: "internal_error" },
    }), { status: 503 })));
    await expect(apiCall(harness.auth.getToken, "/v1/trends/explorer/leads")).rejects.toMatchObject({
      status: 503, code: "trends_busy", message: "Another analysis is still running. Please try again shortly.",
    });
  });

  it.each(["<!DOCTYPE html><html>upstream stack trace</html>", '{"unexpected":"internal detail"}', '["proxy", "failure"]'])(
    "does not expose raw server response %s", async raw => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(raw, { status: 502 })));
      await expect(apiCall(harness.auth.getToken, "/v1/private", { method: "POST" })).rejects.toMatchObject({
        status: 502, message: "Something went wrong on our side. Try again in a moment.",
      });
    },
  );

  it("preserves actionable API errors in envelopes with leading whitespace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('  \n{"error":{"code":"agent_offline","message":"Open the desktop agent.","requestId":"r1"}}', { status: 503 })));
    await expect(apiCall(harness.auth.getToken, "/v1/private", { method: "POST" })).rejects.toMatchObject({
      status: 503, code: "agent_offline", message: "Open the desktop agent.", requestId: "r1",
    });
  });
});
