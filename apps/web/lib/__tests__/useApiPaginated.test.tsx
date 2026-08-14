import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  auth: {
    getToken: vi.fn(),
    isLoaded: true,
    isSignedIn: true,
    userId: "user-a" as string | null,
  },
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => harness.auth,
}));

import { useApiPaginated } from "../useApiPaginated";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pageResponse(items: Array<{ id: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ items, nextBefore: null }),
  } as Response;
}

beforeEach(() => {
  harness.auth.isLoaded = true;
  harness.auth.isSignedIn = true;
  harness.auth.userId = "user-a";
  harness.auth.getToken.mockReset();
  harness.auth.getToken.mockImplementation(async () =>
    harness.auth.userId ? `token-${harness.auth.userId}` : null,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useApiPaginated account changes", () => {
  it("clears and aborts user A pages while a slow failing A request retires", async () => {
    const slowA = deferred<Response>();
    const signals = new Map<string, AbortSignal>();
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)
        ?.authorization;
      if (authorization) signals.set(authorization, init!.signal as AbortSignal);
      if (authorization === "Bearer token-user-a") return slowA.promise;
      return Promise.resolve(pageResponse([{ id: "b-1" }]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = renderHook(() =>
      useApiPaginated<{ id: string }>("/v1/opponents", 7),
    );

    await waitFor(() => {
      expect(signals.has("Bearer token-user-a")).toBe(true);
    });

    harness.auth.userId = "user-b";
    view.rerender();

    // Account A's result is hidden synchronously, before effect cleanup runs.
    expect(view.result.current.items).toEqual([]);
    expect(view.result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(view.result.current.items).toEqual([{ id: "b-1" }]);
    });
    expect(signals.get("Bearer token-user-a")?.aborted).toBe(true);

    await act(async () => {
      slowA.reject(new Error("late user A failure"));
      await Promise.resolve();
    });

    expect(view.result.current.items).toEqual([{ id: "b-1" }]);
    expect(view.result.current.error).toBeNull();

    harness.auth.isSignedIn = false;
    harness.auth.userId = null;
    view.rerender();

    expect(view.result.current.items).toEqual([]);
    expect(view.result.current.isLoading).toBe(false);
    expect(signals.get("Bearer token-user-b")?.aborted).toBe(true);
  });
});
