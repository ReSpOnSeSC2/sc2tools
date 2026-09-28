/**
 * BrowserVsAgentTable — semantic comparison table and the /download link.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BrowserVsAgentTable, COMPARISON_ROWS } from "../BrowserVsAgentTable";

afterEach(cleanup);

describe("BrowserVsAgentTable", () => {
  it("renders a captioned table with one row header per feature", () => {
    render(<BrowserVsAgentTable />);
    const table = screen.getByRole("table", { name: "In your browser vs the desktop agent" });
    const rowHeaders = within(table).getAllByRole("rowheader").map((cell) => cell.textContent);
    expect(rowHeaders).toEqual(COMPARISON_ROWS.map((row) => row.feature));
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Feature",
      "Browser",
      "Desktop agent",
    ]);
  });

  it("is honest that live scouting needs the agent", () => {
    render(<BrowserVsAgentTable />);
    const row = screen.getByRole("rowheader", { name: "Live pre-game scouting and OBS overlay data" }).closest("tr");
    if (!row) throw new Error("row missing");
    const [browser, agent] = within(row).getAllByRole("cell");
    expect(browser.textContent).toMatch(/^No/);
    expect(browser.textContent).toMatch(/localhost:6119/);
    expect(agent.textContent).toBe("Yes");
  });

  it("keeps its heading outside a focusable, labelled scroll region", () => {
    render(<BrowserVsAgentTable />);
    const region = screen.getByRole("region", { name: "Browser vs desktop agent comparison" });
    expect(region.getAttribute("tabindex")).toBe("0");
    const heading = screen.getByRole("heading", { name: "In your browser vs the desktop agent" });
    expect(region.contains(heading)).toBe(false);
    expect(within(region).getByRole("table")).toBeTruthy();
  });

  it("says Folder Sync runs only while the dashboard is open", () => {
    render(<BrowserVsAgentTable />);
    const row = screen.getByRole("rowheader", { name: "Sync new games while you play, with no tab open" }).closest("tr");
    if (!row) throw new Error("row missing");
    expect(within(row).getAllByRole("cell")[0]?.textContent).toMatch(/SC2 Tools dashboard/);
  });

  it("links to the agent download", () => {
    render(<BrowserVsAgentTable />);
    const link = screen.getByRole("link", { name: "Install the agent for live features" });
    expect(link.getAttribute("href")).toBe("/download");
  });
});
