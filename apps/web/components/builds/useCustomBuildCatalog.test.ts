import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { CustomBuildCatalogProvider, fetchCustomBuildCatalog, useCustomBuildCatalog } from "./useCustomBuildCatalog";

const harness = vi.hoisted(() => ({
  userId: "account-a" as string | null,
  revision: 1,
  getToken: vi.fn().mockResolvedValue("token"),
  apiCall: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: !!harness.userId, userId: harness.userId, getToken: harness.getToken }),
}));
vi.mock("@/lib/clientApi", () => ({ apiCall: (...args: unknown[]) => harness.apiCall(...args) }));
vi.mock("@/lib/filterContext", () => ({ useFilters: () => ({ dbRev: harness.revision }) }));
afterEach(() => {
  cleanup();
  harness.userId = "account-a";
  harness.revision = 1;
  harness.apiCall.mockReset();
});

describe("custom build catalog pagination", () => {
  it("reads every page and retains only lightweight metadata", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, index) => ({ slug: `build-${index}`, name: `Build ${index}`, race: "Terran", rules: [{ huge: "payload" }] })),
        nextCursor: "older-cursor",
      })
      .mockResolvedValueOnce({ items: [{ slug: "build-100", name: "Old build", race: "Zerg", vsRace: "Any" }], nextCursor: null });
    const signal = new AbortController().signal;
    const items = await fetchCustomBuildCatalog(request, signal);
    expect(items).toHaveLength(101);
    expect(items[100].name).toBe("Old build");
    expect(items[0]).not.toHaveProperty("rules");
    expect(request.mock.calls[1][0]).toBe("/v1/custom-builds?view=summary&limit=100&cursor=older-cursor");
    expect(request.mock.calls.every(([, current]) => current === signal)).toBe(true);
  });

  it("deduplicates builds moved by concurrent edits", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ items: [{ slug: "same", name: "Before", race: "Protoss" }], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [{ slug: "same", name: "After", race: "Protoss" }], nextCursor: null });
    expect(await fetchCustomBuildCatalog(request, new AbortController().signal)).toEqual([
      { slug: "same", name: "After", race: "Protoss", vsRace: undefined },
    ]);
  });

  it("rejects a repeated cursor instead of reporting a partial catalog as complete", async () => {
    const request = vi.fn().mockResolvedValue({ items: [], nextCursor: "same" });
    await expect(fetchCustomBuildCatalog(request, new AbortController().signal)).rejects.toThrow("Couldn't finish");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not request another page after unmount or account change aborts", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { items: [], nextCursor: "next" };
    });
    await expect(fetchCustomBuildCatalog(request, controller.signal)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("hides the previous account immediately and ignores its late response", async () => {
    let resolveFirst!: (value: unknown) => void;
    harness.apiCall
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ items: [{ slug: "b", name: "Account B", race: "Terran" }], nextCursor: null });
    const { result, rerender } = renderHook(() => useCustomBuildCatalog(), { wrapper: CustomBuildCatalogProvider });
    harness.userId = "account-b";
    rerender();
    expect(result.current.data).toBeUndefined();
    expect(harness.apiCall.mock.calls[0][2].signal.aborted).toBe(true);
    await waitFor(() => expect(result.current.data?.items[0].name).toBe("Account B"));
    await act(async () => resolveFirst({ items: [{ slug: "a", name: "Account A", race: "Protoss" }], nextCursor: null }));
    expect(result.current.data?.items.map((build) => build.name)).toEqual(["Account B"]);
    harness.userId = null;
    rerender();
    expect(result.current.data).toBeUndefined();
  });

  it("shares one page walk across current and newly mounted Arcade consumers", async () => {
    harness.apiCall
      .mockResolvedValueOnce({
        items: Array.from({ length: 100 }, (_, index) => ({ slug: `build-${index}`, name: `Build ${index}`, race: "Terran" })),
        nextCursor: "older",
      })
      .mockResolvedValueOnce({ items: [{ slug: "build-100", name: "Older build", race: "Zerg" }], nextCursor: null })
      .mockResolvedValueOnce({ items: [{ slug: "new", name: "Refreshed build", race: "Protoss" }], nextCursor: null });
    function Consumer({ id }: { id: number }) {
      const catalog = useCustomBuildCatalog();
      return createElement("output", { "data-testid": `consumer-${id}` }, catalog.data?.items.length ?? "loading");
    }
    const tree = (count: number) => createElement(CustomBuildCatalogProvider, {
      children: Array.from({ length: count }, (_, id) => createElement(Consumer, { id, key: id })),
    });
    const { rerender, unmount } = render(tree(3));
    await waitFor(() => expect(screen.getByTestId("consumer-2").textContent).toBe("101"));
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
    rerender(tree(5));
    expect(screen.getByTestId("consumer-4").textContent).toBe("101");
    expect(harness.apiCall).toHaveBeenCalledTimes(2);
    harness.revision = 2;
    rerender(tree(5));
    expect(screen.getByTestId("consumer-0").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("consumer-4").textContent).toBe("1"));
    expect(harness.apiCall).toHaveBeenCalledTimes(3);
    unmount();
    expect(harness.apiCall.mock.calls[2][2].signal.aborted).toBe(true);
  });
});
