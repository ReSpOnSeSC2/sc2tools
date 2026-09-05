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
