import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { ChartTooltip, type ChartTooltipRow } from "../ChartTooltip";

afterEach(cleanup);

// The bug we are guarding against: rows rendered in a near-black colour
// (inherited from a dark bar's fill) on the near-black tooltip box.
// ChartTooltip pins every row to a fixed legible colour, so no row may
// ever come back dark.
const ILLEGIBLE = new Set(["#000", "#000000", "black", "", "transparent"]);

function rowText(el: HTMLElement): string {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

describe("ChartTooltip", () => {
  it("renders the header and every row with legible colours", () => {
    const rows: ChartTooltipRow[] = [
      { key: "wr", label: "Win rate", value: "60%" },
      { key: "sample", label: "Sample", value: "85 games · avg 5145 MMR" },
    ];
    const { container } = render(
      <ChartTooltip header="5100–5199 MMR" rows={rows} />,
    );

    // Header present and coloured (not the dark default).
    const root = container.firstElementChild as HTMLElement;
    const header = root.firstElementChild as HTMLElement;
    expect(header.textContent).toBe("5100–5199 MMR");
    expect(ILLEGIBLE.has(header.style.color.toLowerCase())).toBe(false);

    // Both rows present with their full text — nothing clipped.
    const text = rowText(container as unknown as HTMLElement);
    expect(text).toContain("Win rate");
    expect(text).toContain("60%");
    expect(text).toContain("Sample");
    expect(text).toContain("85 games · avg 5145 MMR");

    // Every value cell is a legible colour.
    const valueCells = container.querySelectorAll<HTMLElement>(
      "div > div > span:last-child",
    );
    expect(valueCells.length).toBeGreaterThan(0);
    for (const cell of Array.from(valueCells)) {
      expect(ILLEGIBLE.has(cell.style.color.toLowerCase())).toBe(false);
    }
  });

  it("renders a colour swatch for multi-series rows", () => {
    const { container } = render(
      <ChartTooltip
        header="2026-03-29"
        rows={[
          { key: "na", label: "NA 267727", value: "5,368", dot: "#7c8cff" },
          { key: "eu", label: "EU 8780508", value: "5,237", dot: "#3ec07a" },
        ]}
      />,
    );
    const swatches = container.querySelectorAll<HTMLElement>(
      'span[aria-hidden="true"]',
    );
    expect(swatches.length).toBe(2);
    expect(swatches[0].style.background).toBe("rgb(124, 140, 255)");
  });

  it("renders nothing when there are no rows", () => {
    const { container } = render(<ChartTooltip header="x" rows={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("omits the header when none is given", () => {
    const { container } = render(
      <ChartTooltip rows={[{ label: "Win rate", value: "59%" }]} />,
    );
    const text = within(container as unknown as HTMLElement);
    expect(text.getByText("Win rate")).toBeTruthy();
    expect(text.getByText("59%")).toBeTruthy();
  });
});
