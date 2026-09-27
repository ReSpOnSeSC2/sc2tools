import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ArcadeStore, resetArcadeStoresForTests } from "../hooks/arcadeStore";
import { useArcadeState } from "../hooks/useArcadeState";
import type { ArcadeState } from "../types";

/**
 * Every Arcade surface used to own a private copy of the saved blob and
 * PUT it on its own debounce, so the last writer erased the others'
 * changes (a Stock Market lock-in dropped the play record the runner
 * saved beside it). These tests pin the shared-store guarantees.
 */

const AUTH = { isLoaded: true, isSignedIn: true, userId: "u1", getToken: async () => "tok" };
vi.mock("@clerk/nextjs", () => ({ useAuth: () => AUTH }));
vi.mock("@/lib/clientApi", () => ({ apiCall: vi.fn() }));
const apiCall = vi.mocked((await import("@/lib/clientApi")).apiCall);

type Call = { method: string; body?: Partial<ArcadeState> };
let calls: Call[];
let remote: Partial<ArcadeState>;

function lastPut(): Partial<ArcadeState> | undefined {
  return calls.filter((c) => c.method === "PUT").at(-1)?.body;
}

beforeEach(() => {
  calls = [];
  remote = {};
  resetArcadeStoresForTests();
  apiCall.mockReset();
  apiCall.mockImplementation(async (_getToken, _path, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return method === "GET" ? remote : {};
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const lockWeek = (s: ArcadeState): ArcadeState => ({
  ...s,
  stockMarket: { weekKey: "2026-W39", lockedAt: "t", picks: [] },
});

describe("ArcadeStore", () => {
  test("subscribers share one hydrate", async () => {
    const store = new ArcadeStore(true);
    store.subscribe(() => {});
    store.subscribe(() => {});
    await waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });

  test("changes from several writers go out together in one save", async () => {
    vi.useFakeTimers();
    const store = new ArcadeStore(true);
    store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    store.update(lockWeek);
    store.update((s) => ({ ...s, minerals: s.minerals + 5 }));
    await vi.advanceTimersByTimeAsync(600);
    await store.whenIdle();
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0].body?.stockMarket?.weekKey).toBe("2026-W39");
    expect(puts[0].body?.minerals).toBe(5);
  });

  test("mutations before hydrate replay on top of the saved state", async () => {
    remote = { minerals: 250, xp: { total: 1500, level: 6 } };
    const store = new ArcadeStore(true);
    store.update((s) => ({ ...s, minerals: s.minerals + 1 }));
    store.subscribe(() => {});
    await waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(store.getSnapshot().state.minerals).toBe(251);
    expect(store.getSnapshot().state.xp.total).toBe(1500);
  });

  test("saves are sequential and each sends the newest state", async () => {
    let releaseFirst: () => void = () => {};
    const store = new ArcadeStore(true);
    store.subscribe(() => {});
    await waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    apiCall.mockImplementationOnce(async (_g, _p, init?: RequestInit) => {
      calls.push({ method: "PUT", body: JSON.parse(String(init?.body)) });
      await new Promise<void>((r) => { releaseFirst = r; });
      return {};
    });
    vi.useFakeTimers();
    store.update((s) => ({ ...s, minerals: 1 }));
    await vi.advanceTimersByTimeAsync(600);
    store.update((s) => ({ ...s, minerals: 2 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    releaseFirst();
    await store.whenIdle();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body?.minerals)).toEqual([1, 2]);
  });

  test("the last unsubscribe saves at once; a remount reloads after that save", async () => {
    vi.useFakeTimers();
    const store = new ArcadeStore(true);
    const off = store.subscribe(() => {});
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    store.update(lockWeek);
    off();
    await store.whenIdle();
    expect(lastPut()?.stockMarket?.weekKey).toBe("2026-W39");
    remote = { ...lastPut() };
    store.subscribe(() => {});
    expect(store.getSnapshot().hydrated).toBe(false);
    await vi.waitFor(() => expect(store.getSnapshot().hydrated).toBe(true));
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(store.getSnapshot().state.stockMarket?.weekKey).toBe("2026-W39");
  });

  test("a signed-out store never touches the network", async () => {
    const store = new ArcadeStore(false);
    store.subscribe(() => {});
    store.update((s) => ({ ...s, minerals: 9 }));
    expect(store.getSnapshot()).toMatchObject({ hydrated: true, state: { minerals: 9 } });
    await store.whenIdle();
    expect(apiCall).not.toHaveBeenCalled();
  });
});

describe("useArcadeState across components", () => {
  const hooks: Record<string, ReturnType<typeof useArcadeState>> = {};
  function Probe({ name }: { name: string }) {
    const hook = useArcadeState();
    useEffect(() => {
      hooks[name] = hook;
    });
    return null;
  }

  test("a lock-in and the runner's play record both reach the server", async () => {
    render(
      <>
        <Probe name="runner" />
        <Probe name="market" />
      </>,
    );
    await waitFor(() => expect(hooks.runner?.hydrated && hooks.market?.hydrated).toBe(true));
    vi.useFakeTimers();
    act(() => {
      hooks.market.update(lockWeek);
      hooks.runner.recordPlay({ modeId: "stock-market", tz: "UTC", xp: 5, raw: 1, correct: true });
    });
    await vi.advanceTimersByTimeAsync(600);
    const saved = lastPut();
    expect(saved?.stockMarket?.weekKey).toBe("2026-W39");
    expect(saved?.records?.["stock-market"]?.attempts).toBe(1);
    expect(hooks.market.state.records["stock-market"]?.attempts).toBe(1);
    expect(hooks.runner.state.stockMarket?.weekKey).toBe("2026-W39");
  });
});
