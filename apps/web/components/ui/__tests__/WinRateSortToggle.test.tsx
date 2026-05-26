import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, renderHook, act } from "@testing-library/react";
import { WinRateSortToggle } from "../WinRateSortToggle";
import { useSort } from "../SortableTh";

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
