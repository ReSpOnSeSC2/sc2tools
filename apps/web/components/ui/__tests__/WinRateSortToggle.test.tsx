import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { WinRateSortToggle } from "../WinRateSortToggle";
import { useSort, usePersistentSort } from "../SortableTh";

describe("WinRateSortToggle", () => {
  afterEach(() => cleanup());

  it("highlights the selected direction when active", () => {
    render(<WinRateSortToggle dir="desc" active onChange={() => {}} />);
    const high = screen.getByRole("radio", { name: /high → low/i });
    const low = screen.getByRole("radio", { name: /low → high/i });
    expect(high.getAttribute("aria-checked")).toBe("true");
    expect(low.getAttribute("aria-checked")).toBe("false");
  });

  it("highlights nothing when win rate is not the active sort", () => {
    render(<WinRateSortToggle dir="desc" active={false} onChange={() => {}} />);
    for (const r of screen.getAllByRole("radio")) {
      expect(r.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("reports the chosen direction on click", () => {
    const onChange = vi.fn();
    render(<WinRateSortToggle dir="desc" active onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /low → high/i }));
    expect(onChange).toHaveBeenCalledWith("asc");
  });
});

describe("useSort.setSortExplicit", () => {
  it("sets both column and direction deterministically", () => {
    const { result } = renderHook(() => useSort("total", "desc"));
    act(() => result.current.setSortExplicit("winRate", "asc"));
    expect(result.current.sortBy).toBe("winRate");
    expect(result.current.sortDir).toBe("asc");

    const rows = [{ winRate: 0.5 }, { winRate: 0.1 }, { winRate: 0.9 }];
    const sorted = result.current.sortRows(rows, (r, c) => (r as Record<string, unknown>)[c]);
    expect(sorted.map((r) => r.winRate)).toEqual([0.1, 0.5, 0.9]);
  });
});

describe("usePersistentSort", () => {
  const KEY = "test.persistent.sort";
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("persists the user's sort choice to localStorage", async () => {
    const { result } = renderHook(() => usePersistentSort(KEY, "total", "desc"));
    act(() => result.current.setSortExplicit("winRate", "asc"));
    await waitFor(() => {
      const raw = localStorage.getItem(KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw as string)).toEqual({ sortBy: "winRate", sortDir: "asc" });
    });
  });

  it("hydrates from a previously stored preference", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sortBy: "winRate", sortDir: "asc" }));
    const { result } = renderHook(() => usePersistentSort(KEY, "total", "desc"));
    await waitFor(() => {
      expect(result.current.sortBy).toBe("winRate");
      expect(result.current.sortDir).toBe("asc");
    });
  });

  it("ignores a malformed stored value and keeps the default", async () => {
    localStorage.setItem(KEY, "not json");
    const { result } = renderHook(() => usePersistentSort(KEY, "total", "desc"));
    await waitFor(() => expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ sortBy: "total", sortDir: "desc" })));
    expect(result.current.sortBy).toBe("total");
    expect(result.current.sortDir).toBe("desc");
  });
});
