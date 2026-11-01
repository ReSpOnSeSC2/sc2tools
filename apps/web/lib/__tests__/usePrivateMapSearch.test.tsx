import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: { userId: "A" as string | null, isLoaded: true, isSignedIn: true, getToken: async () => "A-token" },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => h.auth }));

import { API_BASE, useApi } from "../clientApi";
import { usePrivateMapSearch } from "../usePrivateMapSearch";

const MAPS = `${API_BASE}/v1/maps`;
const ROWS = [
  { name: "Alcyone LE", wins: 5, losses: 4, total: 9, winRate: 0.56 },
  { name: "Amphion LE", wins: 1, losses: 2, total: 3, winRate: 0.33 },
];
const fetching = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value),
  { status, headers: { "content-type": "application/json" } });
let cache = new Map();
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => cache, keepPreviousData: true, dedupingInterval: 0 }}>{children}</SWRConfig>
);
const opening = {}, route = {};
type Props = { query: string; scope?: "all" | "guides"; open?: boolean };
function renderMaps(initial: Props) {
  return renderHook(({ query, scope = "all", open = true }: Props) => usePrivateMapSearch({
    open, scope, query, ownerKey: "A", openingEpoch: opening, routeEpoch: route,
  }), { wrapper, initialProps: initial });
}
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 260)));
beforeEach(() => {
  cache = new Map(); h.auth.userId = "A"; h.auth.isSignedIn = true; h.auth.isLoaded = true;
  fetching.mockReset().mockImplementation(async () => json(ROWS)); vi.stubGlobal("fetch", fetching);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("personal maps in quick search", () => {
  it("reads nothing until a valid private query settles, then reads once and filters in the browser", async () => {
    const view = renderMaps({ query: "a" });
    await settle();
    expect(view.result.current.phase).toBe("idle"); expect(fetching).not.toHaveBeenCalled();
    view.rerender({ query: "al" });
    expect(view.result.current.phase).toBe("loading");
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    expect(fetching).toHaveBeenCalledOnce(); expect(String(fetching.mock.calls[0][0])).toBe(MAPS);
    expect(view.result.current.choices.map(choice => choice.label)).toEqual(["Alcyone LE"]);
    view.rerender({ query: "am" }); await settle();
    expect(view.result.current.choices.map(choice => choice.href)).toEqual(["/app/maps?focus=Amphion%20LE"]);
    expect(fetching).toHaveBeenCalledOnce();
  });

  it.each([["the Guides scope", { scope: "guides" as const }], ["a closed palette", { open: false }], ["a signed-out viewer", {}]])(
    "never reads for %s", async (label, props) => {
      if (label === "a signed-out viewer") h.auth.isSignedIn = false;
      const view = renderMaps({ query: "alcyone", ...props });
      await settle();
      expect(view.result.current.phase).toBe("idle"); expect(fetching).not.toHaveBeenCalled();
    });

  it("reuses the list Arcade already loaded", async () => {
    const arcade = renderHook(() => useApi<unknown>("/v1/maps"), { wrapper });
    await waitFor(() => expect(arcade.result.current.data).toEqual(ROWS));
    const view = renderMaps({ query: "alc" });
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    expect(fetching).toHaveBeenCalledOnce();
  });

  it("reports a failed read without retrying on its own, and Retry reads again", async () => {
    fetching.mockImplementationOnce(async () => json({ error: { code: "internal_error" } }, 500));
    const view = renderMaps({ query: "alc" });
    await waitFor(() => expect(view.result.current.phase).toBe("error"));
    expect(view.result.current.timedOut).toBe(false); await settle();
    expect(fetching).toHaveBeenCalledOnce();
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    expect(fetching).toHaveBeenCalledTimes(2);
  });

  it("expires a selection draft when the query changes or the palette closes", async () => {
    const view = renderMaps({ query: "alc" });
    await waitFor(() => expect(view.result.current.phase).toBe("ready"));
    const [choice] = view.result.current.choices, draft = view.result.current.selectionDraft(choice)!;
    expect(draft).toMatchObject({ target: { kind: "map", map: "Alcyone LE" }, href: "/app/maps?focus=Alcyone%20LE" });
    expect(draft.isCurrent()).toBe(true);
    view.rerender({ query: "alcy" });
    expect(draft.isCurrent()).toBe(false); expect(view.result.current.selectionDraft(choice)).toBeNull();
    const next = view.result.current.selectionDraft(view.result.current.choices[0])!;
    view.unmount();
    expect(next.isCurrent()).toBe(false);
  });
});
