import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefinitionsCatalog } from "./DefinitionsCatalog";
import { BUILD_DEFINITIONS, definitionHref, definitionId } from "@/lib/build-definitions";
import { BreakdownCard } from "@/components/builds/BuildBreakdownCards";
import { BuildGamesTable } from "@/components/builds/BuildGamesTable";
import { DetectedLine } from "@/components/build-checkin/CheckInParts";
import { PredictedStrategiesList } from "@/components/analyzer/PredictedStrategiesList";
import { StrategyTendencyChart } from "@/components/analyzer/StrategyTendencyChart";

const router = vi.hoisted(() => ({ replace: vi.fn(), params: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => new URLSearchParams(router.params) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, isLoading: false }) }));
beforeEach(() => { router.params = ""; window.history.replaceState({}, "", "/definitions"); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The card for a definition id. */
function card(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no card #${id}`);
  return el;
}

describe("DefinitionsCatalog", () => {
  it("lists the labels the engine catalog used to lack", () => {
    render(<DefinitionsCatalog />);
    expect(within(card("zerg-hatch-first")).getByText("Zerg - Hatch First")).toBeTruthy();
    expect(within(card("tvp-1-1-1-one-base")).getByText("TvP - 1-1-1 One Base")).toBeTruthy();
  });

  it("gives every card an anchor and a copy-link button", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<DefinitionsCatalog />);
    const glaives = card("pvz-stargate-into-glaives");
    expect(glaives.className).toContain("scroll-mt-24");
    fireEvent.click(within(glaives).getByRole("button", { name: "Copy link to PvZ - Stargate into Glaives" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/definitions#pvz-stargate-into-glaives`);
    expect(
      await within(glaives).findByRole("button", { name: "Link to PvZ - Stargate into Glaives copied" }),
    ).toBeTruthy();
  });

  it("links published guides, one per matchup, and none when there are none", () => {
    render(
      <DefinitionsCatalog
        guideLinks={{
          "pvz-stargate-into-glaives": [{ matchup: "PvZ", href: "/guides/pvz/stargate-into-glaives" }],
          "zerg-12-pool": [
            { matchup: "ZvP", href: "/guides/zvp/12-pool" },
            { matchup: "ZvT", href: "/guides/zvt/12-pool" },
          ],
        }}
      />,
    );
    const single = within(card("pvz-stargate-into-glaives")).getByRole("link", {
      name: "PvZ guide for PvZ - Stargate into Glaives",
    });
    expect(single.textContent).toBe("Guide");
    expect(single.getAttribute("href")).toBe("/guides/pvz/stargate-into-glaives");
    const pool = within(card("zerg-12-pool")).getAllByRole("link");
    expect(pool.map((link) => link.textContent)).toEqual(["ZvP guide", "ZvT guide"]);
    expect(within(card("pvz-robo-opener")).queryByRole("link")).toBeNull();
  });

  it("shows the 8-worker patch name and finds the label by it", () => {
    render(<DefinitionsCatalog />);
    expect(within(card("zerg-12-pool")).getByText("Zerg - 8 Pool")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search builds and strategies"), {
      target: { value: "8 pool" },
    });
    expect(document.getElementById("zerg-12-pool")).toBeTruthy();
    expect(document.getElementById("pvz-robo-opener")).toBeNull();
  });

  it("shows all matchup pills, implies the race, and persists filters with the hash", async () => {
    window.history.replaceState({}, "", "/definitions#unmatched");
    render(<DefinitionsCatalog />);
    const matchups = within(screen.getByRole("group", { name: "Filter by matchup" }));
    expect(matchups.getAllByRole("button")).toHaveLength(10);
    fireEvent.click(matchups.getByRole("button", { name: "TvZ" }));
    expect(matchups.getByRole("button", { name: "TvZ" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("group", { name: "Filter by race" })).getByRole("button", { name: "Terran" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(router.replace).toHaveBeenLastCalledWith("/definitions?race=T&matchup=TvZ#unmatched", { scroll: false }));
  });

  it("reads URL filters, ignores invalid values, and groups live counts by race and matchup", () => {
    router.params = "q=Stargate&race=P&matchup=PvZ";
    render(<DefinitionsCatalog />);
    expect((screen.getByLabelText("Search builds and strategies") as HTMLInputElement).value).toBe("Stargate");
    const entries = BUILD_DEFINITIONS.filter((def) => def.race === "Protoss" && (def.matchup === "PvZ" || !def.matchup) && /stargate/i.test(`${def.name} ${def.description}`));
    expect(screen.getByRole("heading", { name: `Protoss (${entries.length})`, level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^PvZ \(\d+\)$/, level: 3 })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Terran/, level: 2 })).toBeNull();
  });

  it("ignores invalid URL race/matchup values and follows incoming filter navigation", () => {
    router.params = "race=X&matchup=bad";
    const view = render(<DefinitionsCatalog />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
    router.params = "q=12+Pool&race=Z";
    window.history.replaceState({}, "", "/definitions?q=12+Pool&race=Z");
    view.rerender(<DefinitionsCatalog />);
    expect((screen.getByLabelText("Search builds and strategies") as HTMLInputElement).value).toBe("12 Pool");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /^Zerg \(/, level: 2 })).toBeTruthy();
  });

  it("reveals and focuses a hidden hash target on mount and hashchange", async () => {
    router.params = "q=impossible&race=T";
    window.history.replaceState({}, "", "/definitions?q=impossible&race=T#zerg-12-pool");
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true });
    render(<DefinitionsCatalog />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Zerg - 12 Pool"));
    expect(card("zerg-12-pool").className).toContain("ring-2");
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    fireEvent.change(screen.getByLabelText("Search builds and strategies"), { target: { value: "nonsense" } });
    window.history.replaceState({}, "", "/definitions#pvz-stargate-into-glaives");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("PvZ - Stargate into Glaives"));
    expect((screen.getByLabelText("Search builds and strategies") as HTMLInputElement).value).toBe("");
  });

  it("links known strategy labels on all dossier and check-in surfaces and leaves unknown labels plain", () => {
    const label = "Zerg - 12 Pool";
    const { container } = render(<><BreakdownCard title="Vs opponent strategy" rows={[{ name: label, wins: 1, losses: 0, total: 1 }]} emptySub="No strategies" /><BuildGamesTable games={[{ gameId: "definition-game", date: "2026-10-23", result: "win", opp_strategy: label }]} /><DetectedLine detected={label} /><PredictedStrategiesList predictions={[{ strategy: label, probability: 1 }]} /><StrategyTendencyChart strategies={[{ strategy: label, wins: 1, losses: 0, count: 1, winRate: 1 }]} /><DetectedLine detected="My unknown private strategy" /></>);
    expect(screen.getAllByRole("link", { name: `What is ${label}?` })).toHaveLength(6);
    expect(screen.queryByRole("link", { name: "What is My unknown private strategy?" })).toBeNull();
    const row = container.querySelector('[data-game-row-id="definition-game"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("link", { name: `What is ${label}?` }), { cancelable: true });
    expect(within(row).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("definition links", () => {
  it("resolves exact and matchup-prefixed race labels and 8-worker aliases without guessing unknowns", () => {
    expect(definitionId("Zerg - 12 Pool")).toBe("zerg-12-pool");
    expect(definitionHref("Zerg - 12 Pool")).toBe("/definitions#zerg-12-pool");
    expect(definitionHref("ZvP - 12 Pool")).toBe("/definitions#zerg-12-pool");
    expect(definitionHref("Zerg - 8 Pool")).toBe("/definitions#zerg-12-pool");
    expect(definitionHref("PvZ - Stargate into Glaives")).toBe("/definitions#pvz-stargate-into-glaives");
    expect(definitionHref("Completely unknown")).toBeNull();
    for (const def of BUILD_DEFINITIONS) expect(definitionHref(def.name)).toBe(`/definitions#${def.id}`);
  });
});
