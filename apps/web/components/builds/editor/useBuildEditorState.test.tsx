import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREVIEW_DEBOUNCE_MS, type BuildEditorDraft } from "@/lib/build-rules";
import type {
  BuildEditorContext,
  BuildEditorPreviewResult,
} from "./BuildEditor.types";

const harness = vi.hoisted(() => ({
  getToken: vi.fn(async () => "test-token"),
  apiCall: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
}));

import { useBuildEditorState } from "./useBuildEditorState";

const initialDraft: BuildEditorDraft = {
  name: "PvT test build",
  description: "",
  race: "Protoss",
  vsRace: "Terran",
  skillLevel: null,
  shareWithCommunity: false,
  winConditions: [],
  losesTo: [],
  transitionsInto: [],
  rules: [{ type: "before", name: "BuildGateway", time_lt: 90 }],
};

const context: BuildEditorContext = {
  sourceEvents: [],
  sourceRows: [],
  defaultName: "PvT test build",
  perspective: "you",
};

function preview(gameId: string): BuildEditorPreviewResult {
  return {
    matches: [{ game_id: gameId, build_name: `Build ${gameId}` }],
    almost_matches: [],
    scanned_games: 1,
    truncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function startDebouncedPreview() {
  await act(async () => {
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBuildEditorState preview requests", () => {
  it("aborts a superseded request and prevents its stale result from winning", async () => {
    const first = deferred<BuildEditorPreviewResult>();
    const second = deferred<BuildEditorPreviewResult>();
    harness.apiCall
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );

    await startDebouncedPreview();
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
    const firstInit = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(firstInit.signal).toBeInstanceOf(AbortSignal);
    expect(firstInit.signal?.aborted).toBe(false);

    act(() => {
      result.current.updateRule(0, { time_lt: 120 });
    });
    expect(firstInit.signal?.aborted).toBe(true);

    await startDebouncedPreview();
    expect(harness.apiCall).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(preview("new"));
      await Promise.resolve();
    });
    expect(result.current.preview?.matches[0]?.game_id).toBe("new");
    expect(result.current.previewLoading).toBe(false);

    await act(async () => {
      first.resolve(preview("stale"));
      await Promise.resolve();
    });
    expect(result.current.preview?.matches[0]?.game_id).toBe("new");
    expect(result.current.previewError).toBeNull();
  });

  it("aborts the active preview when the editor unmounts", async () => {
    const pending = deferred<BuildEditorPreviewResult>();
    harness.apiCall.mockImplementationOnce(() => pending.promise);

    const { unmount } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );
    await startDebouncedPreview();

    const init = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(init.signal?.aborted).toBe(false);
    unmount();
    expect(init.signal?.aborted).toBe(true);
  });

  it("replaces opaque browser fetch failures with a safe retry message", async () => {
    harness.apiCall.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );
    await startDebouncedPreview();

    expect(result.current.previewLoading).toBe(false);
    expect(result.current.previewError).toBe(
      "The server connection was interrupted. Your build is safe — wait a moment, then change a rule to try again.",
    );
  });
});

describe("useBuildEditorState save", () => {
  it("cancels an active preview and saves without waiting for it", async () => {
    const pendingPreview = deferred<BuildEditorPreviewResult>();
    harness.apiCall
      .mockImplementationOnce(() => pendingPreview.promise)
      .mockResolvedValueOnce({ ok: true, reclassify: { status: "queued" } });

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );
    await startDebouncedPreview();
    const previewInit = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(previewInit.signal?.aborted).toBe(false);

    await act(async () => {
      await result.current.save(true);
    });

    expect(previewInit.signal?.aborted).toBe(true);
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
    const saveInit = harness.apiCall.mock.calls[1]?.[2] as RequestInit;
    expect(JSON.parse(String(saveInit.body))).toMatchObject({ reclassify: true });
    expect(result.current.savedOk).toBe(true);
  });

  it("explains that queued replay matching continues after the build is saved", async () => {
    harness.apiCall.mockResolvedValueOnce({
      ok: true,
      reclassify: { status: "queued" },
    });

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );

    await act(async () => {
      await result.current.save(true);
    });

    expect(result.current.savedOk).toBe(true);
    expect(result.current.toasts.map((toast) => toast.text)).toContain(
      "Saved — replay matching continues in the background.",
    );
    expect(result.current.toasts.map((toast) => toast.text)).not.toContain(
      "Saved — no games matched yet.",
    );
    const request = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ reclassify: true });
  });

  it("keeps ordinary Save distinct and does not request replay matching", async () => {
    harness.apiCall.mockResolvedValueOnce({
      ok: true,
      reclassify: null,
    });

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft }),
    );

    await act(async () => {
      await result.current.save(false);
    });

    const request = harness.apiCall.mock.calls[0]?.[2] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ reclassify: false });
    expect(result.current.toasts.map((toast) => toast.text)).not.toContain(
      "Saved — replay matching continues in the background.",
    );
  });

  it("keeps the build saved and reports a background queue failure", async () => {
    const onSaved = vi.fn();
    harness.apiCall.mockResolvedValueOnce({
      ok: false,
      saved: true,
      reclassify: null,
      reclassifyError: "The replay worker is temporarily unavailable.",
    });

    const { result } = renderHook(() =>
      useBuildEditorState({ open: true, context, initialDraft, onSaved }),
    );

    await act(async () => {
      await result.current.save(true);
    });

    expect(result.current.savedOk).toBe(true);
    expect(result.current.saveError).toBeNull();
    expect(result.current.toasts.map((toast) => toast.text)).not.toContain(
      expect.stringContaining("replay matching couldn't start"),
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        reclassifyRequested: true,
        reclassifyError: "The replay worker is temporarily unavailable.",
      }),
    );
  });
});
