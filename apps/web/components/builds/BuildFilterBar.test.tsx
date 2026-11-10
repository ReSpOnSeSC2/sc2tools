import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildFilterBar, type BuildFilterState } from "./BuildFilterBar";
import { activeBuildFilterCount, buildFilterApiQuery, buildFiltersQuery, DEFAULT_BUILD_FILTERS, readBuildFilters } from "./buildLibraryFilters";
afterEach(cleanup);
const defaults: BuildFilterState = DEFAULT_BUILD_FILTERS;
it("reports library counts rather than the current page size", () => {
  const view = render(<BuildFilterBar value={defaults} onChange={vi.fn()} total={120} libraryTotal={120} />);
  expect(screen.getByText("120 builds")).toBeTruthy();
  view.rerender(<BuildFilterBar value={{ ...defaults, search: "blink" }} onChange={vi.fn()} total={12} libraryTotal={120} />);
  expect(screen.getByText("12 of 120 builds match")).toBeTruthy();
  view.rerender(<BuildFilterBar value={{ ...defaults, search: "blink" }} onChange={vi.fn()} total={12} libraryTotal={null} />);
  expect(screen.getByText("12 builds match")).toBeTruthy();
});
it("clears search, commits Enter, and focuses search with slash without stealing input or dialog keys", () => {
  const change = vi.fn(); const commit = vi.fn();
  render(<><BuildFilterBar value={{ ...defaults, search: "blink" }} onChange={change} onSearchCommit={commit} total={2} />
    <input aria-label="Other field" /></>);
  const input = screen.getByRole("textbox", { name: "Search" });
  fireEvent.click(screen.getByRole("button", { name: "Clear search" })); expect(change).toHaveBeenCalledWith(defaults);
  fireEvent.keyDown(input, { key: "Enter" }); expect(commit).toHaveBeenCalledOnce();
  screen.getByRole("textbox", { name: "Other field" }).focus(); fireEvent.keyDown(document, { key: "/" });
  expect(document.activeElement).not.toBe(input);
  (document.activeElement as HTMLElement).blur();
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
  fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).not.toBe(input);
  dialog.remove();
  fireEvent.keyDown(document, { key: "/" }); expect(document.activeElement).toBe(input);
});
it("validates URL filters and omits defaults on serialization", () => {
  expect(readBuildFilters(new URLSearchParams("mu=bad&sort=nope&hide=true&src=x&pub=yes&race=Q"))).toEqual(defaults);
  expect(readBuildFilters(new URLSearchParams("q=blink&mu=PvT&sort=name&hide=1"))).toEqual({ ...defaults, search: "blink", matchup: "PvT", sort: "name", hideEmpty: true, race: "P" });
  expect(buildFiltersQuery(defaults)).toBe("");
  expect(buildFiltersQuery({ ...defaults, search: "blink" })).toBe("q=blink");
});
it("round-trips source, published, race and tags through the URL and counts them in Clear filters", () => {
  const query = "src=opp&pub=1&race=Z&tags=Cheese,Macro";
  const filters = readBuildFilters(new URLSearchParams(query));
  expect(filters).toEqual({ ...defaults, source: "opp", published: true, race: "Z", tags: ["Cheese", "Macro"] });
  expect(buildFiltersQuery(filters)).toBe("src=opp&pub=1&race=Z&tags=Cheese%2CMacro");
  expect(readBuildFilters(new URLSearchParams(buildFiltersQuery(filters)))).toEqual(filters);
  expect(activeBuildFilterCount(filters)).toBe(5);
  expect(buildFilterApiQuery(filters)).toEqual({ perspective: "opponent", published: true, race: "Z", tags: ["Cheese", "Macro"] });
  // A matchup carries its race; the API gets the matchup instead of race.
  expect(buildFilterApiQuery({ ...defaults, race: "P", matchup: "PvZ", source: "mine" })).toEqual({ perspective: "you", published: undefined, race: undefined, tags: undefined });
  const clear = vi.fn();
  render(<BuildFilterBar value={filters} onChange={vi.fn()} onClearFilters={clear} total={1} libraryTotal={9} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters (5)" }));
  expect(clear).toHaveBeenCalledOnce();
});
it("switches Mine / Opponent captures, Published and tags, and opens a race into its matchups", () => {
  const change = vi.fn();
  const view = render(<BuildFilterBar value={defaults} onChange={change} total={3} availableTags={[{ tag: "Cheese", count: 2 }]} />);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Whose builds" })).getByRole("radio", { name: "Opponent captures" }));
  expect(change).toHaveBeenLastCalledWith({ ...defaults, source: "opp" });
  fireEvent.click(screen.getByRole("button", { name: "Published" }));
  expect(change).toHaveBeenLastCalledWith({ ...defaults, published: true });
  fireEvent.click(screen.getByRole("button", { name: "#Cheese" }));
  expect(change).toHaveBeenLastCalledWith({ ...defaults, tags: ["Cheese"] });
  expect(screen.queryByRole("button", { name: "ZvP" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Zerg builds" }));
  expect(change).toHaveBeenLastCalledWith({ ...defaults, race: "Z", matchup: "All" });
  view.rerender(<BuildFilterBar value={{ ...defaults, race: "Z" }} onChange={change} total={3} />);
  expect(screen.getByRole("button", { name: "Zerg builds" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "ZvP" }));
  expect(change).toHaveBeenLastCalledWith({ ...defaults, race: "Z", matchup: "ZvP" });
});
