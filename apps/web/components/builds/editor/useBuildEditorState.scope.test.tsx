import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEditorDraft } from "@/lib/build-rules";
import { PREVIEW_DEBOUNCE_MS } from "@/lib/build-rules";
import { useBuildEditorState } from "./useBuildEditorState";
import { BUILD_EDITOR_REQUEST_MS } from "./useBuildEditorRequests";

const h = vi.hoisted(() => ({ owner: "A" as string | null, loaded: true, token: vi.fn<() => Promise<string | null>>(), toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: h.owner, isLoaded: h.loaded, isSignedIn: !!h.owner, getToken: h.token }) }));
vi.mock("@/components/ui/Toast", () => ({ useToastOptional: () => ({ toast: h.toast }) }));
const initialDraft: BuildEditorDraft = { name: "Editor A", description: "", notes: "", race: "Protoss", vsRace: "Zerg", skillLevel: null, shareWithCommunity: false, winConditions: [], losesTo: [], transitionsInto: [], rules: [] };
const context = { sourceEvents: [], sourceRows: [], defaultName: "Reference A", perspective: "you" as const };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const flush = async () => { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { h.owner = "A"; h.loaded = true; h.token.mockResolvedValue("token-A"); fetcher = vi.fn(async () => json({ saved: true, reclassify: null })); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function editor(onSaved = vi.fn(), draft = initialDraft) {
  const view = renderHook(({ open, slug }) => useBuildEditorState({ open, initialDraft: draft, context, lockedSlug: slug, onSaved }), { initialProps: { open: true, slug: "reference-a" } });
  return { ...view, onSaved };
}
const noCompletion = (onSaved: ReturnType<typeof vi.fn>) => { expect(onSaved).not.toHaveBeenCalled(); expect(h.toast.success).not.toHaveBeenCalled(); expect(h.toast.warning).not.toHaveBeenCalled(); };

describe("real editor transport ownership and deadlines", () => {
  it.each(["signature", "create-only"])("cancels a held JWT when the %s source contract changes", async boundary => {
    const token = deferred<string>(); h.token.mockImplementation(() => token.promise);
    const first = [{ unit: "Stargate", count: 2, beforeSec: 240 }];
    const onSaved = vi.fn();
    const view = renderHook(({ signature, createOnly }) => useBuildEditorState({ open: true, context,
      initialDraft, sourceSignature: signature, createOnly, onSaved }), { initialProps: { signature: first, createOnly: true } });
    let save!: Promise<void>; act(() => { save = view.result.current.save(false); });
    await flush(); expect(h.token).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
    view.rerender({ signature: boundary === "signature" ? [{ ...first[0], count: 3 }] : first, createOnly: boundary !== "create-only" });
    await act(async () => { token.resolve("token-A"); await save; });
    expect(fetcher).not.toHaveBeenCalled(); noCompletion(onSaved);
  });
  it.each(["owner", "loading", "source", "close", "unmount"])("does not dispatch a held JWT after %s invalidates its operation", async boundary => {
    const token = deferred<string | null>(); h.token.mockReturnValue(token.promise); const view = editor();
    let save!: Promise<void>; act(() => { save = view.result.current.save(false); }); await flush();
    expect(fetcher).not.toHaveBeenCalled();
    if (boundary === "unmount") view.unmount();
    else if (boundary === "owner") { h.owner = "B"; view.rerender({ open: true, slug: "reference-a" }); }
    else if (boundary === "loading") { h.loaded = false; view.rerender({ open: true, slug: "reference-a" }); }
    else if (boundary === "source") view.rerender({ open: true, slug: "reference-b" });
    else view.rerender({ open: false, slug: "reference-a" });
    await act(async () => { token.resolve("token-B"); await save; });
    expect(fetcher).not.toHaveBeenCalled(); noCompletion(view.onSaved);
  });

  it("ignores a held save body after owner A→B→A without repairing publication or completing the old draft", async () => {
    const body = deferred<unknown>(); fetcher.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const view = editor(); let save!: Promise<void>; act(() => { save = view.result.current.save(false); }); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    h.owner = "B"; view.rerender({ open: true, slug: "reference-a" }); h.owner = "A"; view.rerender({ open: true, slug: "reference-a" });
    await act(async () => { body.resolve({ saved: true, community: { mirrorPending: true, error: "late-confirmation" } }); await save; });
    expect(fetcher).toHaveBeenCalledTimes(1); noCompletion(view.onSaved); expect(view.result.current.savedOk).toBe(false);
  });

  it("fences the held publication-repair body and every completion callback on an owner switch", async () => {
    const repair = deferred<unknown>(); fetcher.mockResolvedValueOnce(json({ saved: true, community: { mirrorPending: true } })).mockResolvedValueOnce({ ok: true, status: 200, json: () => repair.promise });
    const view = editor(); let save!: Promise<void>; act(() => { save = view.result.current.save(false); }); await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    h.owner = "B"; view.rerender({ open: true, slug: "reference-a" }); h.owner = "A"; view.rerender({ open: true, slug: "reference-a" });
    await act(async () => { repair.resolve({ published: true, mirrorPending: false }); await save; });
    noCompletion(view.onSaved); expect(view.result.current.savedOk).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["token", "headers", "body"])("bounds a stalled %s with the shared operation deadline and refuses its late result", async phase => {
    vi.useFakeTimers(); const held = deferred<unknown>();
    if (phase === "token") h.token.mockReturnValue(held.promise as Promise<string | null>);
    if (phase === "headers") fetcher.mockReturnValue(held.promise);
    if (phase === "body") fetcher.mockResolvedValue({ ok: true, status: 200, json: () => held.promise });
    const view = editor(); let save!: Promise<void>; act(() => { save = view.result.current.save(false); }); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(BUILD_EDITOR_REQUEST_MS + 1); await save; });
    expect(view.result.current.saving).toBe(false); expect(view.result.current.saveError).toMatch(/too long|timed out/); noCompletion(view.onSaved);
    await act(async () => { held.resolve(phase === "token" ? "late-token" : phase === "headers" ? json({ saved: true, community: { mirrorPending: true } }) : { saved: true, community: { mirrorPending: true } }); });
    expect(fetcher).toHaveBeenCalledTimes(phase === "token" ? 0 : 1); noCompletion(view.onSaved);
  });

  it("does not issue a preview POST from a held JWT after an owner loading/ABA boundary", async () => {
    vi.useFakeTimers(); const token = deferred<string | null>(); h.token.mockReturnValue(token.promise);
    const view = editor(vi.fn(), { ...initialDraft, rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS); });
    expect(h.token).toHaveBeenCalledTimes(1); h.loaded = false; view.rerender({ open: true, slug: "reference-a" }); h.loaded = true; view.rerender({ open: true, slug: "reference-a" });
    await act(async () => token.resolve("returned-token")); expect(fetcher).not.toHaveBeenCalled(); expect(view.result.current.preview).toBeNull();
  });

  it("does not adopt a stale preview body after owner A→B→A", async () => {
    vi.useFakeTimers(); const body = deferred<unknown>(); fetcher.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const view = editor(vi.fn(), { ...initialDraft, rules: [{ type: "before", name: "BuildPylon", time_lt: 60 }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS); }); expect(fetcher).toHaveBeenCalledTimes(1);
    h.owner = "B"; view.rerender({ open: true, slug: "reference-a" }); h.owner = "A"; view.rerender({ open: true, slug: "reference-a" });
    await act(async () => body.resolve({ matches: [{ game_id: "old-private" }], almost_matches: [], scanned_games: 1, truncated: false }));
    expect(view.result.current.preview).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not refill inspection data from a held body after source A→B→A", async () => {
    const body = deferred<unknown>(); fetcher.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const view = editor(); act(() => view.result.current.toggleInspect("private-game-a")); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender({ open: true, slug: "reference-b" }); view.rerender({ open: true, slug: "reference-a" });
    await act(async () => body.resolve({ events: [{ time: 18, name: "Old private action" }] })); expect(view.result.current.inspectCache).toEqual({}); expect(view.result.current.inspectLoading).toEqual({});
  });
});
