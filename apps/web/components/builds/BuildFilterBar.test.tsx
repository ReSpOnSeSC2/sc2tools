import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuildFilterBar } from "./BuildFilterBar";
import { buildFiltersQuery, readBuildFilters } from "./buildLibraryFilters";
afterEach(cleanup);
const defaults = { search: "", matchup: "All", sort: "updated", hideEmpty: false } as const;
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
  expect(readBuildFilters(new URLSearchParams("mu=bad&sort=nope&hide=true"))).toEqual(defaults);
  expect(readBuildFilters(new URLSearchParams("q=blink&mu=PvT&sort=name&hide=1"))).toEqual({ search: "blink", matchup: "PvT", sort: "name", hideEmpty: true });
  expect(buildFiltersQuery(defaults)).toBe("");
  expect(buildFiltersQuery({ ...defaults, search: "blink" })).toBe("q=blink");
});
