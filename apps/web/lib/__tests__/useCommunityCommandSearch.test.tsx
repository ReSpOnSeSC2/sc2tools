import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMUNITY_COMMAND_DEBOUNCE_MS, COMMUNITY_COMMAND_TIMEOUT_MS, communityCommandUrl } from "../communityCommandSearch";
import { useCommunityCommandSearch, type CommunityCommandSearchOptions } from "../useCommunityCommandSearch";

const fetching = vi.fn<typeof fetch>();
function answer(url: string, slugs: string[] = ["build-a1"]) {
  const body = { version: 1, hasMore: false, items: slugs.map(slug => ({ slug, title: `Build ${slug}`, matchup: null, authorName: null, votes: 1 })) };
  const result = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
const OPTIONS: CommunityCommandSearchOptions = { open: true, scope: "all", query: "zerg", typed: true, signedOut: true };
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 260)));
beforeEach(() => {
  fetching.mockReset().mockImplementation(async input => answer(String(input)));
  vi.stubGlobal("fetch", fetching);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Community builds for signed-out viewers", () => {
  it("sends one request after an explicit edit settles, and none for the opening query", async () => {
    const view = renderHook((props: CommunityCommandSearchOptions) => useCommunityCommandSearch(props),
      { initialProps: { ...OPTIONS, typed: false } });
    await settle();
    expect(view.result.current.phase).toBe("idle"); expect(fetching).not.toHaveBeenCalled();
    view.rerender({ ...OPTIONS, query: "zer" }); view.rerender(OPTIONS);
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    expect(fetching).toHaveBeenCalledOnce(); expect(String(fetching.mock.calls[0][0])).toBe(communityCommandUrl("zerg"));
    expect(view.result.current.items.map(item => item.href)).toEqual(["/community/builds/build-a1"]);
  });

  it.each([
    ["a signed-in or still-loading viewer", { signedOut: false }],
    ["the Guides scope", { scope: "guides" as const }],
    ["a closed palette", { open: false }],
    ["a one-letter query", { query: "z" }],
  ])("never sends for %s", async (_label, overrides) => {
    const view = renderHook(() => useCommunityCommandSearch({ ...OPTIONS, ...overrides }));
    await settle();
    expect(view.result.current.phase).toBe("idle"); expect(fetching).not.toHaveBeenCalled();
  });

  it("aborts an older request on a newer edit, so its late answer never shows", async () => {
    let release!: (value: Response) => void;
    fetching.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const view = renderHook((props: CommunityCommandSearchOptions) => useCommunityCommandSearch(props), { initialProps: OPTIONS });
    await waitFor(() => expect(fetching).toHaveBeenCalledOnce());
    const signal = fetching.mock.calls[0][1]?.signal;
    view.rerender({ ...OPTIONS, query: "protoss" });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    await act(async () => release(answer(communityCommandUrl("zerg"), ["stale"])));
    expect(view.result.current.items.map(item => item.id)).toEqual(["community:build-a1"]);
  });

  it("gives up after five seconds and reports a failure", async () => {
    vi.useFakeTimers();
    fetching.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const view = renderHook(() => useCommunityCommandSearch(OPTIONS));
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMUNITY_COMMAND_DEBOUNCE_MS); });
    expect(fetching).toHaveBeenCalledOnce(); expect(view.result.current.phase).toBe("loading");
    await act(async () => { await vi.advanceTimersByTimeAsync(COMMUNITY_COMMAND_TIMEOUT_MS - 1); });
    expect(view.result.current.phase).toBe("loading");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(view.result.current.phase).toBe("error"); expect(fetching.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("waits for Retry after a failure", async () => {
    fetching.mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    const view = renderHook(() => useCommunityCommandSearch(OPTIONS));
    await waitFor(() => expect(view.result.current.phase).toBe("error"));
    await settle(); expect(fetching).toHaveBeenCalledOnce();
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    expect(fetching).toHaveBeenCalledTimes(2);
  });
});
