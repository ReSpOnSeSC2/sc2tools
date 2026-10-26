import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const history = vi.hoisted(() => ({ hold: false, replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (notify: () => void) => { window.addEventListener("fixture-navigation", notify); window.addEventListener("popstate", notify); return () => { window.removeEventListener("fixture-navigation", notify); window.removeEventListener("popstate", notify); }; };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
    usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => "/app/builds"),
    useRouter: () => history,
  };
});
import { SECTION_QUERY_KEYS, useUrlState } from "../useUrlState";
import { VIEW_FILTER_KEYS } from "../analyzerViews";
function navigate(href: string, event = "fixture-navigation") { window.history.replaceState(null, "", href); window.dispatchEvent(new Event(event)); }
const text = { defaultValue: "", parse: (raw: string | null) => raw && raw.length <= 200 && !/[\u0000-\u001f]/.test(raw) ? raw : "", serialize: (value: string) => value || null };
beforeEach(() => {
  history.hold = false; localStorage.clear(); history.replace.mockReset(); history.push.mockReset();
  for (const method of [history.replace, history.push]) method.mockImplementation(href => { if (!history.hold) navigate(href); });
  navigate("/app/builds?filters=1&race=P#section", "popstate"); vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("useUrlState", () => {
  it("debounces draft text and batches cursor clearing with committed query updates", () => {
    const { result } = renderHook(() => useUrlState("q", text));
    act(() => result.current.setMany({ q: "Gateway", cursor: null }));
    expect(result.current.value).toBe("Gateway"); expect(result.current.committedValue).toBe("");
    act(() => { vi.advanceTimersByTime(299); }); expect(history.replace).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(history.replace).toHaveBeenCalledTimes(1); expect(history.replace.mock.calls[0][1]).toEqual({ scroll: false });
    expect(window.location.search).toContain("q=Gateway"); expect(window.location.search).toContain("race=P"); expect(window.location.hash).toBe("#section");
    expect(result.current.committedValue).toBe("Gateway");
  });
  it("keeps a newer text timer through an older owned router acknowledgement", () => {
    history.hold = true; const { result } = renderHook(() => useUrlState("q", text));
    act(() => result.current.setValue("A")); act(() => { vi.advanceTimersByTime(300); }); const first = history.replace.mock.calls[0][0];
    act(() => result.current.setValue("AB")); act(() => navigate(first));
    expect(result.current.value).toBe("AB");
    act(() => { vi.advanceTimersByTime(300); }); expect(history.replace).toHaveBeenCalledTimes(2);
    expect(history.replace.mock.calls[1][0]).toContain("q=AB");
  });
  it("takes external and Back values immediately and cancels a stale draft", () => {
    const { result } = renderHook(() => useUrlState("q", text));
    act(() => result.current.setValue("stale"));
    act(() => navigate("/app/builds?q=shared", "popstate"));
    expect(result.current.value).toBe("shared");
    act(() => { vi.advanceTimersByTime(400); }); expect(history.replace).not.toHaveBeenCalled();
  });
  it("pushes a drill once, omits defaults and never pushes while typing", () => {
    const { result } = renderHook(() => useUrlState("drill", { ...text, mode: "push" }));
    act(() => result.current.setValue("strategy:Pool")); expect(history.push).toHaveBeenCalledTimes(1);
    act(() => result.current.setValue("strategy:Pool")); expect(history.push).toHaveBeenCalledTimes(1);
    act(() => result.current.setValue("", { mode: "replace" })); expect(new URLSearchParams(window.location.search).has("drill")).toBe(false);
  });
  it("prefers URL over validated storage and uses storage only when absent", () => {
    localStorage.setItem("analyzer.strategies.view", JSON.stringify("opp"));
    const options = { defaultValue: "bvs", storageKey: "analyzer.strategies.view", parse: (raw: string | null) => raw === "opp" ? "opp" : "bvs", serialize: (value: string) => value };
    const first = renderHook(() => useUrlState("view", options)); expect(first.result.current.value).toBe("opp"); first.unmount();
    navigate("/app/strategies?view=bvs", "popstate"); const second = renderHook(() => useUrlState("view", options)); expect(second.result.current.value).toBe("bvs");
    act(() => second.result.current.setValue("opp")); expect(second.result.current.value).toBe("opp");
    act(() => second.result.current.setValue("bvs")); expect(second.result.current.value).toBe("bvs");
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
  });
  it("drops pending writes on unmount and rejects a global-filter patch", () => {
    const { result, unmount } = renderHook(() => useUrlState("q", text));
    expect(() => result.current.setMany({ map: "Wrong key" })).toThrow(/global filters/);
    act(() => result.current.setValue("abandoned")); unmount(); act(() => { vi.advanceTimersByTime(400); }); expect(history.replace).not.toHaveBeenCalled();
    expect(SECTION_QUERY_KEYS.filter(key => VIEW_FILTER_KEYS.includes(key))).toEqual([]);
  });
  it("flushes a pending search with a new immediate filter and deletes only allowed legacy aliases", () => {
    navigate("/app/replays?replaySearch=legacy&cursor=older", "popstate");
    const { result } = renderHook(() => useUrlState("q", text));
    act(() => result.current.setMany({ q: "fresh", cursor: null }));
    act(() => result.current.setMany({ result: "loss", replaySearch: null }, { debounceMs: 0 }));
    expect(history.replace).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("q")).toBe("fresh"); expect(params.get("result")).toBe("loss");
    expect(params.has("cursor")).toBe(false); expect(params.has("replaySearch")).toBe(false);
    expect(() => result.current.setMany({ replaySearch: "forbidden" })).toThrow();
  });
});
