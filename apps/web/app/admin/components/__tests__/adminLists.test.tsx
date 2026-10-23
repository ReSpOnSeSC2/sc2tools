import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coerceAdminQuery, useAdminQueryState } from "../useAdminQueryState";
import { useAdminCursor } from "../useAdminCursor";
import { AdminTable, AdminMobileSort, type AdminColumn } from "../AdminTable";
import { navigation, router } from "./navigationFixture";

vi.mock("next/navigation", () => import("./navigationFixture"));
beforeEach(() => { navigation.url = "/admin/users"; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const defaults = { q: "", filter: "all", page: 0, before: "", unread: true };

describe("admin URLs", () => {
  it("coerces values and rejects invalid enums and non-finite numbers", () => {
    expect(coerceAdminQuery(defaults, new URLSearchParams("q=player&page=2&unread=0&filter=bad"), { filter: ["all", "games"] })).toEqual({ ...defaults, q: "player", page: 2, unread: false });
    expect(coerceAdminQuery(defaults, new URLSearchParams("page=-4&unread=maybe"))).toEqual(defaults);
    expect(coerceAdminQuery(defaults, new URLSearchParams("page=Infinity"))).toEqual(defaults);
    expect(coerceAdminQuery(defaults, new URLSearchParams("page=2.6")).page).toBe(2);
  });
  it("omits defaults, preserves unknown parameters, resets pagination and uses page history", () => {
    navigation.url = "/admin/users?debug=1&page=3&before=cursor";
    const { result } = renderHook(() => useAdminQueryState(defaults, { allowed: { filter: ["all", "games"] } }));
    act(() => result.current[1]({ filter: "games" }));
    expect(router.replace).toHaveBeenLastCalledWith("/admin/users?debug=1&filter=games", { scroll: false });
    act(() => result.current[1]({ page: 2 }));
    expect(router.push).toHaveBeenLastCalledWith("/admin/users?debug=1&filter=games&page=2", { scroll: false });
    act(() => result.current[1]({ filter: "all", unread: false }));
    expect(navigation.url).toBe("/admin/users?debug=1&unread=0");
    act(() => navigation.visit("/admin/users?debug=1&filter=games&page=2"));
    expect(result.current[0]).toMatchObject({ filter: "games", page: 2, unread: true });
  });
  it("debounces one search write and cancels pending typing after Back and unmount", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAdminQueryState(defaults, { debounceMs: { q: 300 } }));
    for (const q of ["p", "pl", "pla", "play", "playe"]) act(() => { result.current[1]({ q }); vi.advanceTimersByTime(40); });
    expect(router.replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));
    expect(router.replace).toHaveBeenCalledTimes(1); expect(result.current[0].q).toBe("playe");
    act(() => result.current[1]({ q: "stale" }));
    act(() => navigation.visit("/admin/users?q=restored&page=2"));
    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toMatchObject({ q: "restored", page: 2 }); expect(router.replace).toHaveBeenCalledTimes(1);
    act(() => result.current[1]({ q: "wrong-page" })); act(() => navigation.visit("/admin/global?q=restored&page=2"));
    act(() => vi.advanceTimersByTime(500)); expect(router.replace).toHaveBeenCalledTimes(1);
    act(() => result.current[1]({ q: "abandoned" })); unmount(); act(() => vi.advanceTimersByTime(500)); expect(router.replace).toHaveBeenCalledTimes(1);
  });
  it("a shared cursor offers First page; Back also restores the Previous stack", () => {
    navigation.url = "/admin/users?before=shared";
    const { result } = renderHook(() => { const [state, set] = useAdminQueryState({ before: "" }); return useAdminCursor(state.before, before => set({ before })); });
    expect(result.current.prevLabel).toBe("First page");
    act(() => result.current.previous()); expect(navigation.url).toBe("/admin/users");
    act(() => result.current.next("one")); act(() => result.current.next("two"));
    act(() => navigation.visit("/admin/users?before=one"));
    act(() => result.current.previous()); expect(navigation.url).toBe("/admin/users");
  });
});

describe("shared admin table", () => {
  const columns: AdminColumn<{ id: string; name: string; games: number }>[] = [
    { key: "name", label: "Player", sortKey: "name", kind: "text", mobile: "title", render: row => row.name },
    { key: "games", label: "Games", sortKey: "games", kind: "number", align: "right", mobile: "field", render: row => row.games },
  ];
  it("exposes sort semantics, text defaults, mobile cards and a real stretched row link", () => {
    const onChange = vi.fn(); const sort = { by: "games", dir: "desc" as const, onChange };
    render(<><AdminMobileSort columns={columns} sort={sort} /><AdminTable columns={columns} rows={[{ id: "one", name: "Player One", games: 5 }]} rowKey={row => row.id} rowHref={row => `/player/${row.id}`} sort={sort} empty="Empty" caption="Players" /></>);
    const table = screen.getByRole("table"); expect(within(table).getByRole("columnheader", { name: "Games" }).getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(table).getByRole("button", { name: "Games" })); expect(onChange).toHaveBeenLastCalledWith("games", "asc");
    fireEvent.click(within(table).getByRole("button", { name: "Player" })); expect(onChange).toHaveBeenLastCalledWith("name", "asc");
    const row = within(table).getByRole("row", { name: "Player One 5" }); expect(row.hasAttribute("onclick")).toBe(false); expect(within(row).getByRole("link").className).toContain("after:inset-0"); expect(within(row).getByRole("link").getAttribute("href")).toBe("/player/one");
    expect(within(screen.getByRole("list", { name: "Players, cards" })).getByRole("link", { name: "Player One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Highest first" })).toBeTruthy();
  });
  it("retains existing rows and exposes Updating while a new key revalidates", () => {
    render(<AdminTable columns={columns} rows={[{ id: "one", name: "Still here", games: 5 }]} rowKey={row => row.id} loading updating empty="Empty" caption="Players" />);
    expect(screen.getByRole("table").closest('[aria-busy="true"]')).toBeTruthy(); expect(screen.getAllByText("Still here")).toHaveLength(2); expect(screen.getByRole("status").textContent).toContain("Updating");
  });
});
