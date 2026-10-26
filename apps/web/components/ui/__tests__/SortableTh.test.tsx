import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { SortableTh, usePersistentSort } from "../SortableTh";

afterEach(cleanup);

describe("SortableTh", () => {
  it("restores a saved sort without overwriting it during root StrictMode", () => {
    const key = "synthetic-sort-preference", saved = { sortBy: "games", sortDir: "asc" };
    localStorage.setItem(key, JSON.stringify(saved));
    function PersistentTable() {
      const sort = usePersistentSort(key, "lastPlayed", "desc");
      return <table><thead><tr><SortableTh col="games" label="Games" {...sort} /></tr></thead></table>;
    }
    const view = render(<StrictMode><PersistentTable /></StrictMode>);
    try {
      expect(screen.getByRole("columnheader", { name: /Games/ }).getAttribute("aria-sort")).toBe("ascending");
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
    } finally { view.unmount(); localStorage.removeItem(key); }
  });

  it("exposes sorting as a keyboard-focusable button with aria-sort", () => {
    const setSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableTh
              col="netMmr"
              label="Net MMR"
              sortBy="netMmr"
              sortDir="desc"
              setSort={setSort}
              align="right"
              compact
            />
          </tr>
        </thead>
      </table>,
    );

    const header = screen.getByRole("columnheader", { name: /Net MMR/i });
    expect(header.getAttribute("aria-sort")).toBe("descending");

    const button = screen.getByRole("button", { name: /Net MMR/i });
    expect(button.className).toContain("px-2 py-1.5");
    fireEvent.click(button);
    expect(setSort).toHaveBeenCalledWith("netMmr");
  });
});
