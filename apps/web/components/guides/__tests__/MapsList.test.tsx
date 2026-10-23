import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MapViews } from "../map/MapViews";
import type { GuideIndexMap } from "@/lib/guides/types";
const maps: GuideIndexMap[] = [
  { map: "Alcyone LE", slug: "alcyone-le", games: 400, cells: [{ matchup: "PvZ", games: 120, winRate: 0.6, ci: { low: 0.5, high: 0.7 } }] },
  { map: "Site Delta LE", slug: "site-delta-le", games: 500, cells: [{ matchup: "PvZ", games: 130, winRate: 0.4, ci: { low: 0.3, high: 0.5 } }] },
  { map: "Amphion LE", slug: "amphion-le", games: 200, cells: [] },
];
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const table = () => screen.getByRole("table", { name: "Map pool win rates by matchup" });
const names = () => within(table()).getAllByRole("rowheader").map((row) => row.textContent);
it("switches Gallery/Table, remembers the choice and narrows a race to two columns", () => {
  render(<MapViews maps={maps} />); expect(screen.queryByRole("table")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Table" })); expect(localStorage.getItem("guides.maps.view")).toBe("table");
  expect(within(table()).getAllByRole("columnheader")).toHaveLength(7); expect(screen.getByText("Pick your race to fit the table")).toBeTruthy(); fireEvent.change(screen.getByRole("combobox", { name: "I play" }), { target: { value: "P" } }); expect(within(table()).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Map", "PvT", "PvZ"]); expect(screen.queryByText("Pick your race to fit the table")).toBeNull();
  cleanup(); render(<MapViews maps={maps} />); expect(table()).toBeTruthy();
});
it("sorts missing cells last in both directions and filters map names", () => {
  localStorage.setItem("guides.maps.view", "table"); render(<MapViews maps={maps} />); fireEvent.click(within(table()).getByRole("button", { name: "PvZ" })); expect(names()).toEqual(["Alcyone LE", "Site Delta LE", "Amphion LE"]); fireEvent.click(within(table()).getByRole("button", { name: "PvZ" })); expect(names()).toEqual(["Site Delta LE", "Alcyone LE", "Amphion LE"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a map" }), { target: { value: "site" } }); expect(names()).toEqual(["Site Delta LE"]);
});
it("keeps the gallery usable when storage throws and hides the switch on old payloads", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Unavailable"); }); vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
  const view = render(<MapViews maps={maps} />); expect(screen.queryByRole("table")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Table" })); expect(table()).toBeTruthy(); view.rerender(<MapViews maps={maps.map(({ cells: _cells, ...map }) => map)} />); expect(screen.queryByRole("group", { name: "Map view" })).toBeNull(); expect(screen.queryByRole("table")).toBeNull();
});
