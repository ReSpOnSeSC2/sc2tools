import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { SortableTh, usePersistentSort } from "../SortableTh";
import { InfoTip } from "../InfoTip";

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

  it("keeps real header help separate from sorting and its saved preference", async () => {
    const key = "synthetic-sort-with-help", saved = { sortBy: "netMmr", sortDir: "desc" };
    localStorage.setItem(key, JSON.stringify(saved));
    function TableWithHelp() {
      const sort = usePersistentSort(key, "netMmr", "desc");
      return <table><thead><tr><SortableTh col="netMmr" label="Net MMR" {...sort} compact align="right" width="9rem"
        info={<InfoTip termId="net-mmr" label="Net MMR" />} /></tr></thead></table>;
    }
    const view = render(<TableWithHelp />);
    try {
      const header = screen.getByRole("columnheader", { name: "Net MMR" });
      const sort = within(header).getByRole("button", { name: "Net MMR" });
      const help = within(header).getByRole("button", { name: "About Net MMR" });
      expect(within(header).getAllByRole("button")).toHaveLength(2);
      expect(help.closest("button")?.querySelector("button")).toBeNull();
      expect(sort.contains(help)).toBe(false);
      expect(sort.tabIndex).toBe(0);
      expect(sort.className).toContain("px-2 py-1.5");
      expect(sort.className).toContain("justify-end text-right");
      expect(header.style.width).toBe("9rem");
      fireEvent.click(help);
      const tip = await screen.findByRole("dialog", { name: "About Net MMR" });
      expect((await within(tip).findByRole("link", { name: "Learn more" })).getAttribute("href")).toBe("/help/glossary#net-mmr");
      expect(header.getAttribute("aria-sort")).toBe("descending");
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(saved);
      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.click(sort);
      expect(header.getAttribute("aria-sort")).toBe("ascending");
      await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ sortBy: "netMmr", sortDir: "asc" }));
    } finally { view.unmount(); localStorage.removeItem(key); }
  });
});
