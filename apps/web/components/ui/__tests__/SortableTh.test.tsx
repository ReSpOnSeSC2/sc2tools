import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SortableTh } from "../SortableTh";

afterEach(cleanup);

describe("SortableTh", () => {
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
            />
          </tr>
        </thead>
      </table>,
    );

    const header = screen.getByRole("columnheader", { name: /Net MMR/i });
    expect(header.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: /Net MMR/i }));
    expect(setSort).toHaveBeenCalledWith("netMmr");
  });
});
