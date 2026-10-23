import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  FiltersContext,
  defaultAnalyzerFilters,
  type AnalyzerFilters,
} from "@/lib/filterContext";

const mocks = vi.hoisted(() => ({
  perRace: {} as Record<string, { games: number }>,
  paths: [] as string[],
  configs: [] as unknown[],
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: (path: string, config?: unknown) => {
    mocks.paths.push(path);
    mocks.configs.push(config);
    return { data: { perRace: mocks.perRace }, isLoading: false, error: null };
  },
}));

import { MatchupPicker } from "../MatchupPicker";

afterEach(() => {
  cleanup();
  mocks.perRace = {};
  mocks.paths.length = 0;
  mocks.configs.length = 0;
});

const DEFAULTS = defaultAnalyzerFilters();

function Harness({ initial = DEFAULTS }: { initial?: AnalyzerFilters }) {
  const [filters, setFilters] = useState<AnalyzerFilters>(initial);
  return (
    <FiltersContext.Provider
      value={{ filters, setFilters, dbRev: 0, bumpRev: () => undefined, seasons: [] }}
    >
      <MatchupPicker />
      <output data-testid="filters-state">{JSON.stringify(filters)}</output>
    </FiltersContext.Provider>
  );
}

function state(): AnalyzerFilters {
  return JSON.parse(screen.getByTestId("filters-state").textContent || "{}");
}

function group(): HTMLElement {
  return screen.getByRole("radiogroup", { name: "Matchup" });
}

function checked(): string | null {
  const radio = within(group())
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true");
  return radio ? radio.getAttribute("aria-label") : null;
}

describe("MatchupPicker", () => {
  it("offers All · vs P · vs T · vs Z as one radio group, All picked by default", () => {
    render(<Harness />);
    const radios = within(group()).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["All", "vs P", "vs T", "vs Z"]);
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "All matchups",
      "vs Protoss",
      "vs Terran",
      "vs Zerg",
    ]);
    expect(checked()).toBe("All matchups");
    // One Tab stop: only the checked option is in the tab order.
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("writes opp_race, and All clears it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "vs Zerg" }));
    expect(state().opp_race).toBe("Z");
    expect(checked()).toBe("vs Zerg");

    fireEvent.click(screen.getByRole("radio", { name: "All matchups" }));
    expect(state()).not.toHaveProperty("opp_race");
  });

  it("moves and selects with the arrow keys, wrapping at the ends", () => {
    render(<Harness />);
    const all = screen.getByRole("radio", { name: "All matchups" });
    all.focus();
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(state().opp_race).toBe("P");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "vs Protoss" }));

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(state().opp_race).toBe("Z");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(state()).not.toHaveProperty("opp_race");
    expect(document.activeElement).toBe(all);

    fireEvent.keyDown(all, { key: "ArrowLeft" });
    expect(state().opp_race).toBe("Z");
    expect(screen.getByRole("radio", { name: "vs Zerg" }).tabIndex).toBe(0);
  });

  it("drops an opponent strategy picked for another race", () => {
    render(<Harness initial={{ ...DEFAULTS, opp_race: "Z", opp_strategy: "ZvP - 12 Pool" }} />);
    fireEvent.click(screen.getByRole("radio", { name: "vs Terran" }));
    expect(state()).toMatchObject({ opp_race: "T" });
    expect(state()).not.toHaveProperty("opp_strategy");
  });

  it("shows a Random option only while Random is the chosen opponent", () => {
    render(<Harness initial={{ ...DEFAULTS, opp_race: "R" }} />);
    expect(checked()).toBe("vs Random");
  });

  it("hides My race for a one-race player", () => {
    mocks.perRace = { Protoss: { games: 120 }, Terran: { games: 0 }, Zerg: { games: 0 } };
    render(<Harness />);
    expect(screen.queryByRole("combobox", { name: "My race" })).toBeNull();
  });

  it("offers My race with the races you played when there is more than one", () => {
    mocks.perRace = { Protoss: { games: 120 }, Terran: { games: 0 }, Zerg: { games: 8 } };
    render(<Harness />);
    const select = screen.getByRole("combobox", { name: "My race" }) as HTMLSelectElement;
    expect(Array.from(select.options, (o) => o.textContent)).toEqual([
      "Any race",
      "Protoss",
      "Zerg",
    ]);
    fireEvent.change(select, { target: { value: "Z" } });
    expect(state().race).toBe("Z");
    fireEvent.change(select, { target: { value: "" } });
    expect(state()).not.toHaveProperty("race");
  });

  it("keeps My race visible while a race is picked, so it can be cleared here", () => {
    mocks.perRace = { Protoss: { games: 120 } };
    render(<Harness initial={{ ...DEFAULTS, race: "P" }} />);
    expect(
      (screen.getByRole("combobox", { name: "My race" }) as HTMLSelectElement).value,
    ).toBe("P");
  });

  it("asks for the races played once per visit, without refetching on focus", () => {
    render(<Harness />);
    expect(new Set(mocks.paths)).toEqual(new Set(["/v1/random-summary"]));
    expect(mocks.configs[0]).toMatchObject({
      revalidateOnFocus: false,
      revalidateIfStale: false,
    });
  });
});
