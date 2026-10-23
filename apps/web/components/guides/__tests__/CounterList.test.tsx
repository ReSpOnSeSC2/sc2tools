import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CounterBrowser } from "../counter/CounterBrowser";
import { MatchupGuide } from "../matchup/MatchupGuide";
import { FIXTURE_MATCHUP } from "@/lib/guides/__fixtures__";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/guides/pvz", useSearchParams: () => new URLSearchParams() }));
const counters = [
  { strategyKey: "a", strategySlug: "a", name: "Alpha", published: true, games: 120, winRate: 0.55, ci: { low: 0.4, high: 0.65 } },
  { strategyKey: "z", strategySlug: "z", name: "Zéta", published: true, games: 180, winRate: 0.3, ci: { low: 0.2, high: 0.45 } },
  { strategyKey: "n", strategySlug: "n", name: "New", published: false, games: null, winRate: null, ci: null },
];
afterEach(cleanup);
const names = () => screen.getAllByRole("link").map((link) => link.textContent);
it("server-renders toughest first, supports most-played/A–Z and accent-insensitive search", () => {
  const html = renderToStaticMarkup(<CounterBrowser counters={counters} matchupSlug="pvz" />); expect(html.indexOf("How to beat Zéta")).toBeLessThan(html.indexOf("How to beat Alpha"));
  render(<CounterBrowser counters={counters} matchupSlug="pvz" />); expect(names()).toEqual(["How to beat Zéta", "How to beat Alpha", "How to beat New"]);
  expect(screen.getByText("Not enough games yet")).toBeTruthy(); fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "name" } }); expect(names()[0]).toBe("How to beat Alpha");
  fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "games" } }); expect(names()[0]).toBe("How to beat Zéta");
  fireEvent.change(screen.getByRole("searchbox", { name: "Find an opener" }), { target: { value: "zeta" } }); expect(names()).toEqual(["How to beat Zéta"]); expect(screen.getByText("1 of 3 openers")).toBeTruthy();
});
it("retains the supplied order and says Published first before a new stats run", () => {
  render(<CounterBrowser counters={counters.map(({ winRate: _rate, ci: _ci, ...row }) => row)} matchupSlug="pvz" />); expect(names()[0]).toBe("How to beat Alpha"); expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(""); expect(screen.getByRole("option", { name: "Published first" })).toBeTruthy();
});
it("limits the matchup preview to six published counters and explains their perspective", () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ ...counters[0], strategyKey: `strategy${index}`, strategySlug: `strategy-${index}`, name: `Opener ${index}`, ci: { low: 0.2, high: 0.6 - index * 0.02 } }));
  render(<MatchupGuide payload={{ ...FIXTURE_MATCHUP, counters: many }} />); const section = screen.getByRole("heading", { name: "How to beat Zerg openers" }).closest("section")!;
  expect(within(section).getAllByRole("listitem")).toHaveLength(6); expect(within(section).getAllByRole("listitem")[0].textContent).toContain("Opener 7"); expect(within(section).getByRole("link", { name: "All 8 Zerg openers →" }).getAttribute("href")).toBe("/guides/pvz/counter"); expect(within(section).getByText("Your win rate against each Zerg opener, toughest first.")).toBeTruthy();
});
