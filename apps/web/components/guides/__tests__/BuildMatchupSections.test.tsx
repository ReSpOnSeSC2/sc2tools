import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BuildMapsSection, BuildVsStrategySection } from "../build/BuildMatchupSections";
import { FIXTURE_BUILD_PUBLISHED } from "@/lib/guides/__fixtures__";

afterEach(cleanup);
it("groups verdicts, hides empty groups, and expands only beyond the first five", () => {
  const base = FIXTURE_BUILD_PUBLISHED.vsStrategy[0];
  const even = Array.from({ length: 7 }, (_, index) => ({ ...base, strategyKey: `even${index}`, strategySlug: `even-${index}`, name: `Even ${index}`, ci: { low: 0.4, high: 0.6 }, games: 100 + index }));
  const rows = [{ ...base, strategyKey: "win", name: "Favoured opener", ci: { low: 0.6, high: 0.8 } }, ...even];
  const view = render(<BuildVsStrategySection rows={rows} matchupSlug="pvz" />);
  expect(screen.getByRole("heading", { name: "Favoured (1)" })).toBeTruthy(); expect(screen.getByRole("heading", { name: "Too close to call (7)" })).toBeTruthy(); expect(screen.queryByRole("heading", { name: /Unfavoured/ })).toBeNull();
  const table = screen.getByRole("table", { name: "Too close to call opponent openers" }); expect(within(table).getAllByRole("rowheader")).toHaveLength(5);
  const more = screen.getByRole("button", { name: "Show 2 more" }); expect(more.getAttribute("aria-expanded")).toBe("false"); fireEvent.click(more); expect(within(table).getAllByRole("rowheader")).toHaveLength(7); expect(more.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(within(table).getByRole("button", { name: "Games" })); expect(within(table).getAllByRole("rowheader")[0].textContent).toBe("Even 6");
  view.rerender(<BuildVsStrategySection rows={[{ ...base, published: false, ci: { low: 0.1, high: 0.3 } }]} matchupSlug="pvz" />); expect(screen.getByRole("heading", { name: "Unfavoured (1)" })).toBeTruthy(); expect(screen.queryByRole("link")).toBeNull();
});

it("discloses all maps only beyond six and gates map links by published paths", () => {
  const maps = Array.from({ length: 7 }, (_, index) => ({ ...FIXTURE_BUILD_PUBLISHED.maps[0], map: `Map ${index}`, mapSlug: `map-${index}`, winRate: 0.3 + index * 0.05 }));
  const view = render(<BuildMapsSection maps={maps.slice(0, 6)} publishedPaths={new Set()} />); expect(screen.queryByText("Show all 6 maps")).toBeNull();
  view.rerender(<BuildMapsSection maps={maps} publishedPaths={new Set(["/guides/maps/map-6"])} />);
  fireEvent.click(screen.getByText("Show all 7 maps")); const table = screen.getByRole("table", { name: "All maps for this build" }); expect(within(table).getAllByRole("rowheader")[0].textContent).toBe("Map 6"); expect(within(table).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/guides/maps/map-6"]);
  fireEvent.click(within(table).getByRole("button", { name: "Win rate" })); expect(within(table).getAllByRole("rowheader")[0].textContent).toBe("Map 0");
});
