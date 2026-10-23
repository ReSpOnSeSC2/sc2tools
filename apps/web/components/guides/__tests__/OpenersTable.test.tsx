import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { OpenersTable } from "../matchup/OpenersTable";
import { FIXTURE_MATCHUP } from "@/lib/guides/__fixtures__";

const rows = FIXTURE_MATCHUP.openers.slice(0, 3).map((row, index) => ({ ...row, name: ["Étude", "Bravo", "Alpha"][index], games: [150, 500, 80][index], published: index !== 2, trend: { winRateDelta: 0.02, prevalenceDelta: [0.021, -0.013, 0.004][index], since: "2026-10-01" } }));
const props = { openers: rows, matchupSlug: "pvz", caption: "Ranked openers", canLinkGuides: true };
afterEach(cleanup);
const table = () => screen.getByRole("table", { name: "Ranked openers" });
const names = () => within(table()).getAllByRole("rowheader").map((row) => row.querySelector("a,span")?.textContent);

it("server-renders the supplied Wilson ranking before any client sort", () => {
  const html = renderToStaticMarkup(<OpenersTable {...props} />);
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect([...doc.querySelectorAll("tbody tr")].map((row) => row.firstElementChild?.textContent)).toEqual(["1", "2", "3"]);
  expect([...doc.querySelectorAll("tbody th")].map((row) => row.querySelector("a,span")?.textContent)).toEqual(["Étude", "Bravo", "Alpha"]);
  expect(doc.querySelector('[aria-sort="descending"]')).toBeNull();
});

it("sorts games without changing original ranks and supports both directions", () => {
  render(<OpenersTable {...props} />);
  fireEvent.click(within(table()).getByRole("button", { name: "Games" }));
  expect(names()).toEqual(["Bravo", "Étude", "Alpha"]);
  expect(within(table()).getAllByRole("row").slice(1).map((row) => row.firstElementChild?.textContent)).toEqual(["2", "1", "3"]);
  expect(within(table()).getByRole("columnheader", { name: "Games" }).getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(within(table()).getByRole("button", { name: "Games" })); expect(names()).toEqual(["Alpha", "Étude", "Bravo"]);
});

it("finds names without case or accents, announces the count and clears no matches", () => {
  render(<OpenersTable {...props} />); const search = screen.getByRole("searchbox", { name: "Find an opener" });
  expect(document.getElementById(search.getAttribute("aria-controls")!)).toBe(table());
  fireEvent.change(search, { target: { value: "ETUDE" } }); expect(names()).toEqual(["Étude"]); expect(screen.getByText("1 of 3 openers").getAttribute("aria-live")).toBe("polite");
  fireEvent.change(search, { target: { value: "xyz" } }); expect(screen.getByText(/No opener matches “xyz”/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear" })); expect(names()).toHaveLength(3);
});

it("filters unpublished openers and renders the same ranks as mobile cards", () => {
  const view = render(<OpenersTable {...props} />); fireEvent.click(screen.getByRole("checkbox", { name: "Only openers with a full guide" }));
  expect(names()).toEqual(["Étude", "Bravo"]); const cards = screen.getByRole("list", { name: "Opener cards" }); expect(within(cards).getAllByRole("listitem").map((card) => card.getAttribute("value"))).toEqual(["1", "2"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "games:desc" } }); expect(within(cards).getAllByRole("listitem")[0].textContent).toContain("#2Bravo");
  view.rerender(<OpenersTable {...props} canLinkGuides={false} />); expect(screen.queryByRole("checkbox")).toBeNull(); expect(names()).toHaveLength(3);
});

it("shows popularity movement only beyond the flat threshold", () => {
  render(<OpenersTable {...props} />); expect(within(table()).getByText("↑ 2.1 pp more popular")).toBeTruthy(); expect(within(table()).getByText("↓ 1.3 pp less popular")).toBeTruthy(); expect(within(table()).queryByText(/0.4 pp/)).toBeNull();
});
