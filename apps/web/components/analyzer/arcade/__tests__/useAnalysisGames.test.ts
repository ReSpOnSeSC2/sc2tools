import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
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

// Lets a test hold one account's device read until the account has switched.
const deviceGate = vi.hoisted(() => ({
  hold: null as null | ((accountKey: string) => Promise<void> | undefined),
  afterRead: null as null | ((accountKey: string) => void),
  holdSave: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/analysisCorpus/deviceStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysisCorpus/deviceStore")>();
  return {
    ...actual,
    readDeviceCorpus: async (...args: Parameters<typeof actual.readDeviceCorpus>) => {
      await deviceGate.hold?.(args[1]);
      const stored = await actual.readDeviceCorpus(...args);
      deviceGate.afterRead?.(args[1]);
      return stored;
    },
    saveDeviceSnapshot: async (...args: Parameters<typeof actual.saveDeviceSnapshot>) => {
      await deviceGate.holdSave?.();
      return actual.saveDeviceSnapshot(...args);
    },
  };
});

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
  deviceGate.hold = null;
  deviceGate.afterRead = null;
  deviceGate.holdSave = null;
  window.localStorage.clear();
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

  it("stamps when the corpus last came from the server, and clears it while updating or after a failed update", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_793_000_000_000);
    try {
      providerEnabled = false;
      const { result } = renderHook(() => useAnalysisGames(), { wrapper });
      expect(result.current.syncedAt).toBeNull();

      act(() => result.current.load());
      expect(result.current.syncedAt).toBeNull();
      await waitFor(() => expect(result.current.items).toHaveLength(3));
      expect(result.current.syncedAt).toBe(1_793_000_000_000);
      expect(result.current.keepFailed).toBe(false);

      // Refresh keeps the games on screen; a failure keeps them too, with no time.
      harness.apiCall.mockRejectedValueOnce(new Error("Service unavailable"));
      act(() => result.current.load());
      expect(result.current.syncedAt).toBeNull();
      expect(result.current.items).toHaveLength(3);
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.syncedAt).toBeNull();
      expect(result.current.items).toHaveLength(3);
    } finally {
      now.mockRestore();
    }
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

  it("still loads the corpus in memory when the sync chunk cannot load", async () => {
    vi.doMock("../hooks/analysisCorpusSync", () => {
      throw new Error("Loading chunk failed");
    });
    // A noted account loads the sync chunk; here that load fails.
    noteDeviceCopy("user-a");
    try {
      const { result } = renderHook(() => useAnalysisGames(), { wrapper });
      await waitFor(() => expect(result.current.items).toHaveLength(3));
      expect([result.current.error, result.current.onDevice]).toEqual([null, false]);
      expect(harness.apiCall).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock("../hooks/analysisCorpusSync");
    }
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

  // The first snapshot page carries the marks and every page the epoch, as the
  // API sends them; the changes route answers with `changes`.
  function serve(
    changes: (path: string) => unknown,
    marks: Record<string, unknown> = MARKS,
    cursorEpoch: unknown = marks.corpusEpoch,
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
        ? { items: [game(`${prefix}-c`)], nextCursor: null, corpusEpoch: cursorEpoch }
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
    noteDeviceCopy(accountKey);
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
    // The stored copy shows before the network answers, still updating.
    await waitFor(() => {
      expect(shown(second.result.current.items)).toEqual(["s-a", "s-b", "s-c"]);
    });
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.syncedAt).toBeNull();
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
    expect(second.result.current.syncedAt).toEqual(expect.any(Number));
    expect(requested()).toEqual(["/v1/games/analysis-corpus/changes"]);
    expect(await deviceCopy("user-a")).toEqual({
      marks: next,
      ids: ["new", "s-a", "s-c"],
    });
  });

  it("stamps a first keep's snapshot only once it is saved", async () => {
    serve(() => null);
    let release: (() => void) | undefined;
    deviceGate.holdSave = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.syncedAt).toBeNull();
    expect(result.current.onDevice).toBe(false);

    await waitFor(() => expect(release).toBeTypeOf("function"));
    await act(async () => release?.());
    await waitFor(() => expect(result.current.onDevice).toBe(true));
    expect(result.current.syncedAt).toEqual(expect.any(Number));
    expect(result.current.keepFailed).toBe(false);
  });

  it("says when a keep could not be stored, and asks again on the next load", async () => {
    serve(() => null);
    vi.stubGlobal("indexedDB", undefined);
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(result.current.items).toHaveLength(3);
    expect(result.current.onDevice).toBe(false);
    expect(result.current.keepFailed).toBe(true);

    act(() => result.current.load());
    expect(result.current.keepFailed).toBe(false);
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(result.current.keepFailed).toBe(true);
  });

  it("says when this account's copy could not be stored, on the keep and on each later load until it can be", async () => {
    serve(() => null);
    // The browser is out of space for the rows; the small reset record still fits.
    deviceGate.holdSave = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(result.current.items).toHaveLength(3);
    expect(result.current.onDevice).toBe(false);
    expect(result.current.keepFailed).toBe(true);
    expect(await deviceCopy("user-a")).toBe("kept");

    act(() => result.current.load());
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(result.current.keepFailed).toBe(true);

    deviceGate.holdSave = null;
    act(() => result.current.load());
    await waitFor(() => expect(result.current.onDevice).toBe(true));
    expect(result.current.keepFailed).toBe(false);
  });

  it("does not count a keep over the 20,000-game limit as a failure", async () => {
    // Every page says there is more, so the snapshot stops at its page limit: the corpus ceiling.
    let page = 0;
    harness.apiCall.mockImplementation(async (_getToken, path: string) => {
      if (path.startsWith("/v1/games/analysis-corpus/changes")) return null;
      page += 1;
      const first = !new URL(path, "https://example.test").searchParams.get("cursor");
      return { items: [game(`limit-${page}`)], nextCursor: `next-${page}`, ...(first ? MARKS : { corpusEpoch: EPOCH }) };
    });
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.syncedAt).not.toBeNull());
    expect(result.current.hitCorpusLimit).toBe(true);
    expect(result.current.onDevice).toBe(false);
    expect(result.current.keepFailed).toBe(false);
  });

  it("keeps history for the account that loads next when asked before sign-in finished loading", async () => {
    serve(() => null);
    harness.isLoaded = false;
    harness.userId = null;
    const view = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => view.result.current.keepOnDevice());
    expect(harness.apiCall).not.toHaveBeenCalled();

    harness.isLoaded = true;
    harness.userId = "user-a";
    view.rerender();
    // Daily Pulse's restore effect loads once the account is known.
    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.onDevice).toBe(true));
    expect(await deviceCopy("user-a")).toEqual({ marks: MARKS, ids: ["s-a", "s-b", "s-c"] });
  });

  it("drops a keep asked for before sign-in loaded when nobody turns out to be signed in", async () => {
    serve(() => null);
    harness.isLoaded = false;
    harness.userId = null;
    const view = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => view.result.current.keepOnDevice());
    harness.isLoaded = true;
    harness.isSignedIn = false;
    view.rerender();

    harness.isSignedIn = true;
    harness.userId = "user-a";
    view.rerender();
    act(() => view.result.current.load());
    await waitFor(() => expect(view.result.current.syncedAt).not.toBeNull());
    expect(view.result.current.onDevice).toBe(false);
    expect(view.result.current.keepFailed).toBe(false);
    expect(await factory.databases()).toEqual([]);
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
    // User A's cancelled run wrote nothing after the switch.
    expect(await deviceCopy("user-a")).toEqual({ marks: MARKS, ids: ["a-stored"] });
  });

  it("never lets user A's late stored copy replace user B's corpus", async () => {
    await keepCopy("user-a", ["a-stored"]);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldForA = false;
    deviceGate.hold = (accountKey) => {
      if (accountKey !== "user-a") return undefined;
      heldForA = true;
      return held;
    };
    let readForA: (() => void) | undefined;
    const readDone = new Promise<void>((resolve) => {
      readForA = resolve;
    });
    deviceGate.afterRead = (accountKey) => {
      if (accountKey === "user-a") readForA?.();
    };
    serve(() => null);
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper: wrapperFor(true),
    });
    await waitFor(() => expect(heldForA).toBe(true));

    harness.userId = "user-b";
    rerender();
    await waitFor(() => {
      expect(shown(result.current.items)).toEqual(["b-a", "b-b", "b-c"]);
    });
    // Once user A's read has returned, a macrotask lets its stored copy reach onStored.
    await act(async () => {
      release?.();
      await readDone;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(shown(result.current.items)).toEqual(["b-a", "b-b", "b-c"]);
  });

  it("never lets user A's late snapshot replace user B's corpus", async () => {
    await keepCopy("user-a", ["a-stored"]);
    const fresh = { corpusVersion: 2, watermark: "2026-10-31T12:00:00.000Z", corpusEpoch: EPOCH };
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondRequested = false;
    harness.apiCall.mockImplementation(async (_getToken, path: string) => {
      if (path.startsWith("/v1/games/analysis-corpus/changes")) {
        return { snapshotRequired: "corpus_version", corpusVersion: 2, corpusEpoch: EPOCH };
      }
      const cursor = new URL(path, "https://example.test").searchParams.get("cursor");
      if (cursor) {
        // User A's second page is held until user B's corpus is on screen.
        if (cursor === "a-next") {
          secondRequested = true;
          await secondHeld;
        }
        return { items: [game(`${cursor[0]}-c`)], nextCursor: null, corpusEpoch: EPOCH };
      }
      const prefix = harness.userId === "user-a" ? "a" : "b";
      if (prefix === "a") await firstHeld;
      return { items: [game(`${prefix}-a`), game(`${prefix}-b`)], nextCursor: `${prefix}-next`, ...fresh };
    });
    const { result, rerender } = renderHook(() => useAnalysisGames(), {
      wrapper: wrapperFor(true),
    });
    await waitFor(() => expect(shown(result.current.items)).toEqual(["a-stored"]));

    harness.userId = "user-b";
    rerender();
    await waitFor(() => {
      expect(shown(result.current.items)).toEqual(["b-a", "b-b", "b-c"]);
    });
    // Each release is followed by a macrotask, after which user A's microtask chain has run.
    await act(async () => {
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(secondRequested).toBe(true);
    await act(async () => {
      releaseSecond?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(shown(result.current.items)).toEqual(["b-a", "b-b", "b-c"]);
  });

  it("keeps the request to store history until the device records it", async () => {
    vi.stubGlobal("indexedDB", undefined);
    serve(() => null);
    const { result } = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => result.current.keepOnDevice());
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    expect(result.current.onDevice).toBe(false);

    vi.stubGlobal("indexedDB", factory);
    act(() => result.current.load());
    await waitFor(() => expect(result.current.onDevice).toBe(true));
    expect(await deviceCopy("user-a")).toEqual({
      marks: MARKS,
      ids: ["s-a", "s-b", "s-c"],
    });
  });

  it("never keeps a snapshot whose pages came from two corpus epochs, and finds the kept choice again", async () => {
    serve(() => null, MARKS, "2.fedcba9876543210");
    const first = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => first.result.current.keepOnDevice());
    await waitFor(() => expect(first.result.current.items).toHaveLength(3));
    await waitFor(async () => expect(await deviceCopy("user-a")).toBe("kept"));
    expect(first.result.current.onDevice).toBe(false);
    first.unmount();

    // A later visit, with no keep request, finds the choice and stores a uniform snapshot.
    serve(() => null);
    const second = renderHook(() => useAnalysisGames(), { wrapper });
    act(() => second.result.current.load());
    await waitFor(() => expect(second.result.current.onDevice).toBe(true));
    expect(await deviceCopy("user-a")).toEqual({
      marks: MARKS,
      ids: ["s-a", "s-b", "s-c"],
    });
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
