import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChartFrame } from "../ChartFrame";

afterEach(cleanup);
const rows = [{ name: "Band A", rate: "37.5%", games: 8 }, { name: "Band B", rate: "0%", games: 25 }];
const columns = [{ key: "name", label: "Band", render: (row: typeof rows[number]) => row.name },
  { key: "rate", label: "Rate", render: (row: typeof rows[number]) => row.rate }, { key: "games", label: "Games", render: (row: typeof rows[number]) => row.games }];
describe("ChartFrame same-data access", () => {
  it("offers a keyboard-focusable table of the supplied values and returns to the plot", () => {
    render(<ChartFrame title="Synthetic comparison" summary="Two bands, 33 recorded games." rows={rows} columns={columns}><svg role="img" aria-label="Synthetic plot" /></ChartFrame>);
    expect(screen.getByText("Two bands, 33 recorded games.")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /View as table/ }); toggle.focus(); expect(document.activeElement).toBe(toggle); fireEvent.click(toggle);
    const table = screen.getByRole("table"), region = screen.getByRole("region", { name: "Synthetic comparison data table" });
    expect(region.tabIndex).toBe(0); expect(within(table).getByText("37.5%")).toBeTruthy(); expect(within(table).getByText("0%")).toBeTruthy();
    expect(within(table).getByText("25")).toBeTruthy(); expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show chart/ })); expect(screen.getByRole("img", { name: "Synthetic plot" })).toBeTruthy();
  });
  it("keeps request failure distinct from an empty chart and connects Retry", () => {
    const mutate = vi.fn();
    render(<ChartFrame title="Failed chart" summary="No current answer." rows={[]} columns={columns} query={{ data: undefined, error: { status: 503 }, mutate }} empty={<p>Empty chart</p>}><span>Plot</span></ChartFrame>);
    expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByText("Empty chart")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Retry/i })); expect(mutate).toHaveBeenCalledOnce();
  });
  it("withholds previous-filter summaries and legends after the current request fails", () => {
    render(<ChartFrame title="Current chart" summary="Previous cohort summary" legend={<span>Previous series</span>} rows={rows} columns={columns}
      query={{ data: rows, isPreviousData: true, error: { status: 503 }, mutate: vi.fn() }}><span>Previous plot</span></ChartFrame>);
    expect(screen.getByRole("alert")).toBeTruthy();
    for (const text of ["Previous cohort summary", "Previous series", "Previous plot"]) expect(screen.queryByText(text)).toBeNull();
  });
  it("does not invent table rows while loading or for a confirmed empty response", () => {
    const view = render(<ChartFrame title="Loading chart" summary="Awaiting records." rows={[]} columns={columns} query={{ data: undefined, mutate: vi.fn() }} empty={<p>No matching rows</p>}><span>Plot</span></ChartFrame>);
    expect(screen.queryByText("No matching rows")).toBeNull(); expect(screen.queryByRole("button", { name: /View as table/ })).toBeNull();
    view.rerender(<ChartFrame title="Loading chart" summary="Zero matching records." rows={[]} columns={columns} query={{ data: [], mutate: vi.fn() }} empty={<p>No matching rows</p>}><span>Plot</span></ChartFrame>);
    expect(screen.getByText("No matching rows")).toBeTruthy(); expect(screen.queryByRole("table")).toBeNull();
  });
});
