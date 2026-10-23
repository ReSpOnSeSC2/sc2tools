import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";

const harness = vi.hoisted(() => ({
  auth: {
    getToken: async () => "token",
    isLoaded: true,
    isSignedIn: true as boolean,
    userId: "user-a" as string | null,
  },
}));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => harness.auth }));

import { API_BASE, resourcePath, useApi } from "../clientApi";

/** Requests that stay pending until the test answers them. */
const pending = new Map<string, (body: unknown) => void>();

function answer(path: string, body: unknown) {
  const resolve = pending.get(`${API_BASE}${path}`);
  if (!resolve) throw new Error(`no pending request for ${path}`);
  pending.delete(`${API_BASE}${path}`);
  resolve(body);
}

// The app shell's SWRConfig turns keepPreviousData on for every hook.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), keepPreviousData: true, dedupingInterval: 0 }}>
    {children}
  </SWRConfig>
);

function renderPath(initialPath: string | null) {
  // Read the fields during render, as a component does: SWR only
  // re-renders for the fields a render read.
  return renderHook(
    ({ path }: { path: string | null }) => {
      const response = useApi<{ who: string }>(path);
      return { data: response.data, isPreviousData: response.isPreviousData };
    },
    { wrapper, initialProps: { path: initialPath } },
  );
}

async function load(view: ReturnType<typeof renderPath>, path: string, who: string) {
  await waitFor(() => expect(pending.has(`${API_BASE}${path}`)).toBe(true));
  await act(async () => answer(path, { who }));
  await waitFor(() => expect(view.result.current.data).toEqual({ who }));
}

beforeEach(() => {
  harness.auth.isSignedIn = true;
  harness.auth.userId = "user-a";
  pending.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise((resolve) => {
          pending.set(url, (body) => resolve({ ok: true, status: 200, json: async () => body }));
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useApi keeps the previous answer only within the same account and resource", () => {
  it("keeps it while a filter (the query string) changes", async () => {
    const view = renderPath("/v1/matchups?since=2026-01-01");
    await load(view, "/v1/matchups?since=2026-01-01", "january");

    view.rerender({ path: "/v1/matchups?since=2026-06-01" });
    expect(view.result.current.data).toEqual({ who: "january" });
    expect(view.result.current.isPreviousData).toBe(true);

    await load(view, "/v1/matchups?since=2026-06-01", "june");
    expect(view.result.current.isPreviousData).toBe(false);
  });

  it("drops it when the hook moves to another record", async () => {
    const view = renderPath("/v1/opponents/alpha");
    await load(view, "/v1/opponents/alpha", "alpha");

    view.rerender({ path: "/v1/opponents/beta" });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isPreviousData).toBe(false);
  });

  it("drops the previous filters' answer when the current request fails, even for legacy consumers", async () => {
    const view = renderPath("/v1/matchups?since=2026-01-01");
    await load(view, "/v1/matchups?since=2026-01-01", "january");
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 500, text: async () => JSON.stringify({ error: { code: "internal_error", message: "Failed" } }),
    } as Response);
    view.rerender({ path: "/v1/matchups?since=2026-06-01" });
    await waitFor(() => expect(view.result.current.data).toBeUndefined());
  });

  it("drops it when the account changes", async () => {
    const view = renderPath("/v1/me");
    await load(view, "/v1/me", "account a");

    harness.auth.userId = "user-b";
    view.rerender({ path: "/v1/me" });
    expect(view.result.current.data).toBeUndefined();
  });

  it("drops it when the user signs out", async () => {
    const view = renderPath("/v1/me");
    await load(view, "/v1/me", "account a");

    harness.auth.isSignedIn = false;
    harness.auth.userId = null;
    view.rerender({ path: "/v1/me" });
    expect(view.result.current.data).toBeUndefined();
  });

  it("drops it when the path is cleared", async () => {
    const view = renderPath("/v1/games/1/build-order");
    await load(view, "/v1/games/1/build-order", "game 1");

    view.rerender({ path: null });
    expect(view.result.current.data).toBeUndefined();
  });

  it("does not carry a closed modal's rows into the next one it opens", async () => {
    const view = renderPath("/v1/games-list?leak=supply");
    await load(view, "/v1/games-list?leak=supply", "supply drill");

    view.rerender({ path: null });
    view.rerender({ path: "/v1/games-list?leak=injects" });
    expect(view.result.current.data).toBeUndefined();
    expect(view.result.current.isPreviousData).toBe(false);
  });
});

describe("resourcePath", () => {
  it("strips the query and the revision hash", () => {
    expect(resourcePath("/v1/matchups?since=2026-01-01#3")).toBe("/v1/matchups");
    expect(resourcePath("/v1/matchups#3")).toBe("/v1/matchups");
    expect(resourcePath("/v1/me")).toBe("/v1/me");
  });
});
