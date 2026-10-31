import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openDeviceCorpus,
  readDeviceCorpus,
  saveDeviceSnapshot,
} from "@/lib/analysisCorpus/deviceStore";

const harness = vi.hoisted(() => ({
  dbRev: 0,
  generation: 0,
  isLoaded: true,
  isSignedIn: true,
  userId: "user-a" as string | null,
  getToken: vi.fn(async () => null),
  apiCall: vi.fn(),
}));

let providerEnabled = true;

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    getToken: harness.getToken,
    isLoaded: harness.isLoaded,
    isSignedIn: harness.isSignedIn,
    userId: harness.userId,
  }),
}));

vi.mock("@/lib/filterContext", () => ({
  useFilters: () => ({ dbRev: harness.dbRev }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
}));

import {
  ANALYSIS_GAMES_CORPUS_MAX,
  ANALYSIS_GAMES_MAX_PAGES,
  ANALYSIS_GAMES_PAGE_SIZE,
  ANALYSIS_GAMES_REFRESH_QUIET_MS,
  AnalysisGamesProvider,
  analysisGamesPageKey,
  useAnalysisGames,
  useSettledAnalysisRevision,
} from "../hooks/useAnalysisGames";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  harness.dbRev = 0;
  harness.generation = 0;
  harness.isLoaded = true;
  harness.isSignedIn = true;
  harness.userId = "user-a";
  harness.apiCall.mockReset();
  providerEnabled = true;
  harness.apiCall.mockImplementation(async (_getToken, path: string) => {
    const cursor = new URL(path, "https://example.test").searchParams.get(
      "cursor",
    );
    const prefix = `r${harness.generation}`;
    return cursor
      ? {
          items: [game(`${prefix}-c`)],
          nextCursor: null,
        }
      : {
          items: [game(`${prefix}-a`), game(`${prefix}-b`)],
          nextCursor: `${prefix}-next`,
        };
  });
});

function game(gameId: string) {
  return {
    gameId,
    date: "2026-08-13T12:00:00.000Z",
    result: "Victory",
  };
}

describe("analysisGamesPageKey", () => {
  it("starts at the bounded analysis projection endpoint", () => {
    expect(analysisGamesPageKey(0, null)).toBe(
      `/v1/games/analysis-corpus?limit=${ANALYSIS_GAMES_PAGE_SIZE}`,
    );
  });

  it("carries the opaque cursor without interpreting it in the browser", () => {
    const path = analysisGamesPageKey(1, {
      items: [],
      nextCursor: "date/id + opaque",
    });
    expect(path).toBe(
      `/v1/games/analysis-corpus?limit=${ANALYSIS_GAMES_PAGE_SIZE}`
        + "&cursor=date%2Fid+%2B+opaque",
    );
  });

  it("stops at exhaustion, signed-out state, or the 20k corpus ceiling", () => {
    expect(
      analysisGamesPageKey(1, { items: [], nextCursor: null }),
    ).toBeNull();
    expect(analysisGamesPageKey(0, null, false)).toBeNull();
    expect(
      analysisGamesPageKey(ANALYSIS_GAMES_MAX_PAGES, {
        items: [],
        nextCursor: "more",
      }),
    ).toBeNull();
    expect(ANALYSIS_GAMES_PAGE_SIZE * ANALYSIS_GAMES_MAX_PAGES).toBe(20_000);
    expect(ANALYSIS_GAMES_CORPUS_MAX).toBe(20_000);
  });
});

describe("useSettledAnalysisRevision", () => {
  it("coalesces a resync burst and publishes only after the quiet period", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ revision }) => useSettledAnalysisRevision(revision),
      { initialProps: { revision: 0 } },
    );

    rerender({ revision: 1 });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_GAMES_REFRESH_QUIET_MS - 1);
    });
    expect(result.current).toBe(0);

    // A newer ingest event resets the timer instead of starting another load.
    rerender({ revision: 2 });
    act(() => {
      vi.advanceTimersByTime(ANALYSIS_GAMES_REFRESH_QUIET_MS);
    });
    expect(result.current).toBe(2);
  });
});

describe("AnalysisGamesProvider retention", () => {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const providerProps = {
      enabled: providerEnabled,
      refreshQuietMs: 0,
      children,
    };
    return createElement(AnalysisGamesProvider, providerProps);
  };

  it("does not request any history until a surface explicitly enables it", async () => {
    providerEnabled = false;
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(harness.apiCall).not.toHaveBeenCalled();

    providerEnabled = true;
    rerender();
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.isActive).toBe(true);
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
  });

  it("lets Daily Pulse activate the shared corpus on demand", async () => {
    providerEnabled = false;
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });

    act(() => result.current.load());

    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.isActive).toBe(true);
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight page and releases the corpus when Arcade closes", async () => {
    let requestSignal: AbortSignal | undefined;
    harness.apiCall.mockImplementationOnce(
      async (_getToken, _path: string, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return await new Promise((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      },
    );
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));

    providerEnabled = false;
    rerender();

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await waitFor(() => expect(result.current.isActive).toBe(false));
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("fails closed and aborts user A when the signed-in account changes", async () => {
    let userASignal: AbortSignal | undefined;
    harness.apiCall.mockImplementationOnce(
      async (_getToken, _path: string, init?: RequestInit) => {
        userASignal = init?.signal as AbortSignal | undefined;
        return await new Promise((_resolve, reject) => {
          userASignal?.addEventListener(
            "abort",
            () => reject(new Error("late user A failure")),
            { once: true },
          );
        });
      },
    );

    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(1));

    harness.generation = 1;
    harness.userId = "user-b";
    rerender();

    // The account-bound view hides A before React runs effect cleanup.
    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(userASignal?.aborted).toBe(true));
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r1-a",
        "r1-b",
        "r1-c",
      ]);
    });
    expect(result.current.error).toBeNull();
  });

  it("never renders user A's completed corpus while user B is loading", async () => {
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r0-a",
        "r0-b",
        "r0-c",
      ]);
    });

    let resolveUserB!: (page: {
      items: ReturnType<typeof game>[];
      nextCursor: null;
    }) => void;
    harness.apiCall.mockImplementationOnce(
      async () => await new Promise((resolve) => {
        resolveUserB = resolve;
      }),
    );

    harness.userId = "user-b";
    rerender();

    expect(result.current.items).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    // User B's first page starts after the device-copy probe.
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(3));
    expect(result.current.items).toEqual([]);
    await act(async () => {
      resolveUserB({ items: [game("user-b-game")], nextCursor: null });
    });
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "user-b-game",
      ]);
    });
  });

  it("replaces one flat corpus across revisions without retaining old pages", async () => {
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r0-a",
        "r0-b",
        "r0-c",
      ]);
    });
    const firstSnapshot = result.current.items;
    expect(result.current.pagesFetched).toBe(2);

    harness.generation = 1;
    harness.dbRev = 1;
    rerender();
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r1-a",
        "r1-b",
        "r1-c",
      ]);
    });
    expect(result.current.items).not.toBe(firstSnapshot);
    expect(result.current.items).toHaveLength(3);
    expect(result.current.pagesFetched).toBe(2);

    harness.generation = 2;
    harness.dbRev = 2;
    rerender();
    await waitFor(() => {
      expect(result.current.items.map((row) => row.gameId)).toEqual([
        "r2-a",
        "r2-b",
        "r2-c",
      ]);
    });
    // Two page requests per revision; neither page count nor retained item
    // count grows with old cursor generations.
    expect(harness.apiCall).toHaveBeenCalledTimes(6);
    expect(result.current.pagesFetched).toBe(2);
    expect(result.current.items).toHaveLength(3);
  });
});

describe("AnalysisGamesProvider device copy", () => {
  const EPOCH = "1.0123456789abcdef";
  const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: EPOCH };
  let factory: IDBFactory;
  const wrapperFor = (enabled: boolean) =>
    function DeviceCopyProvider({ children }: { children: ReactNode }) {
      const providerProps = { enabled, refreshQuietMs: 0, children };
      return createElement(AnalysisGamesProvider, providerProps);
    };
  const wrapper = wrapperFor(false);

  beforeEach(() => {
    factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Snapshot pages carry marks; the changes route answers with `changes`.
  function serve(
    changes: (path: string) => unknown,
    marks: Record<string, unknown> = MARKS,
  ) {
    harness.apiCall.mockImplementation(async (_getToken, path: string) => {
      if (path.startsWith("/v1/games/analysis-corpus/changes")) {
        return await changes(path);
      }
      const cursor = new URL(path, "https://example.test").searchParams.get(
        "cursor",
      );
      const prefix = harness.userId === "user-a" ? "s" : "b";
      return cursor
        ? { items: [game(`${prefix}-c`)], nextCursor: null }
        : {
            items: [game(`${prefix}-a`), game(`${prefix}-b`)],
            nextCursor: "next",
            ...marks,
          };
    });
  }

  const requested = () =>
    harness.apiCall.mock.calls.map(([, path]) => String(path).split("?")[0]);
  const shown = (items: Array<{ gameId: string }>) =>
    items.map((row) => row.gameId).sort();

  async function deviceCopy(accountKey: string) {
    const db = await openDeviceCorpus(factory, { create: false });
    if (!db) return null;
    const copy = await readDeviceCorpus<{ gameId: string }>(db, accountKey, 100);
    db.close();
    return copy.kind === "stored"
      ? { marks: copy.marks, ids: shown(copy.rows) }
      : copy.kind;
  }

  async function keepCopy(accountKey: string, ids: string[]) {
    const db = await openDeviceCorpus(factory, { create: true });
    await saveDeviceSnapshot(db!, accountKey, ids.map(game), MARKS, 100);
    db!.close();
  }

  it("keeps history on this device only when asked, then shows it first and syncs only changes", async () => {
    serve(() => null);
    const first = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => first.result.current.load());
    await waitFor(() => expect(first.result.current.items).toHaveLength(3));
    expect(first.result.current.onDevice).toBe(false);
    expect(await factory.databases()).toEqual([]);

    act(() => first.result.current.keepOnDevice());
    await waitFor(() => expect(first.result.current.onDevice).toBe(true));
    expect(await deviceCopy("user-a")).toEqual({
      marks: MARKS,
      ids: ["s-a", "s-b", "s-c"],
    });
    first.unmount();

    let answer: ((page: unknown) => void) | undefined;
    harness.apiCall.mockClear();
    serve(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const second = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => second.result.current.load());
    // The stored copy shows before the network answers.
    await waitFor(() => {
      expect(shown(second.result.current.items)).toEqual(["s-a", "s-b", "s-c"]);
    });
    expect(second.result.current.isLoading).toBe(false);
    await waitFor(() => expect(answer).toBeTypeOf("function"));
    const next = { ...MARKS, watermark: "2026-10-31T11:00:00.000Z" };
    await act(async () => {
      answer?.({
        items: [{ gameId: "s-b", removed: true }, game("new")],
        nextCursor: null,
        ...next,
      });
    });
    await waitFor(() => {
      expect(shown(second.result.current.items)).toEqual(["new", "s-a", "s-c"]);
    });
    expect(requested()).toEqual(["/v1/games/analysis-corpus/changes"]);
    expect(await deviceCopy("user-a")).toEqual({
      marks: next,
      ids: ["new", "s-a", "s-c"],
    });
  });

  it("falls back to a snapshot when the server asks for one, and replaces the stored copy", async () => {
    await keepCopy("user-a", ["old"]);
    const fresh = {
      corpusVersion: 2,
      watermark: "2026-10-31T12:00:00.000Z",
      corpusEpoch: EPOCH,
    };
    serve(
      () => ({ snapshotRequired: "corpus_version", corpusVersion: 2, corpusEpoch: EPOCH }),
      fresh,
    );

    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.load());
    await waitFor(() => {
      expect(shown(result.current.items)).toEqual(["s-a", "s-b", "s-c"]);
    });
    expect(result.current.onDevice).toBe(true);
    expect(requested()).toEqual([
      "/v1/games/analysis-corpus/changes",
      "/v1/games/analysis-corpus",
      "/v1/games/analysis-corpus",
    ]);
    expect(await deviceCopy("user-a")).toEqual({
      marks: fresh,
      ids: ["s-a", "s-b", "s-c"],
    });
  });

  it("never shows another account's stored copy, and leaves this account in memory", async () => {
    await keepCopy("user-b", ["b-only"]);
    serve(() => null);

    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.load());
    await waitFor(() => {
      expect(shown(result.current.items)).toEqual(["s-a", "s-b", "s-c"]);
    });
    expect(result.current.onDevice).toBe(false);
    expect(requested()).toEqual([
      "/v1/games/analysis-corpus",
      "/v1/games/analysis-corpus",
    ]);
    expect(await deviceCopy("user-a")).toBe("absent");
  });

  it("hides user A's stored copy at once when the account switches mid-sync", async () => {
    await keepCopy("user-a", ["a-stored"]);
    let answerA: ((page: unknown) => void) | undefined;
    serve(() => new Promise((resolve) => {
      answerA = resolve;
    }));
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper: wrapperFor(true),
    });
    await waitFor(() => expect(shown(result.current.items)).toEqual(["a-stored"]));
    await waitFor(() => expect(answerA).toBeTypeOf("function"));

    harness.userId = "user-b";
    rerender();
    expect(result.current.items).toEqual([]);
    await act(async () => {
      answerA?.({ items: [game("a-late")], nextCursor: null, ...MARKS });
    });
    await waitFor(() => {
      expect(shown(result.current.items)).toEqual(["b-a", "b-b", "b-c"]);
    });
    expect(result.current.onDevice).toBe(false);
    expect(await deviceCopy("user-b")).toBe("absent");
  });

  it("does not recreate a copy that another tab cleared after it was kept", async () => {
    serve(() => ({ items: [], nextCursor: null, ...MARKS }));
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.onDevice).toBe(true));

    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase("sc2tools-analysis-corpus");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    harness.apiCall.mockClear();
    act(() => result.current.load());
    await waitFor(() => expect(result.current.onDevice).toBe(false));
    expect(requested()).toEqual([
      "/v1/games/analysis-corpus",
      "/v1/games/analysis-corpus",
    ]);
    expect(await factory.databases()).toEqual([]);
  });
});
