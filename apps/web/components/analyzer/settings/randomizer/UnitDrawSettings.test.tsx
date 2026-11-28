import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRandomizerConfig, emptyMatchupConfig } from "@/lib/randomizer/config";
import { MATCHUP_UNIT_POOLS } from "@/lib/randomizer/openingUnitPools";
import type { MatchupConfig, MatchupKey } from "@/lib/randomizer/types";
import { DrawSwitches, drawSummary } from "./DrawSwitches";
import { MatchupBuildPicker } from "./MatchupBuildPicker";
import { MatchupSelector, drawsLabel } from "./MatchupSelector";
import { previewBlocker } from "./RandomizerPreview";
import { UnitDrawSettings } from "./UnitDrawSettings";

afterEach(cleanup);

function buildConfig(overrides: Partial<MatchupConfig> = {}): MatchupConfig {
  return {
    enabled: true,
    useCustomWeights: false,
    unitRandomizerEnabled: true,
    builds: [
      {
        id: "build-alpha",
        name: "PvT - Build Alpha",
        race: "Protoss",
        source: "catalog",
        weight: 1,
        openingUnits: {
          gateCount: 1,
          useCustomWeights: false,
          units: [
            { id: "zealot", weight: 1 },
            { id: "stalker", weight: 1 },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function Harness({ initial = buildConfig(), matchup = "PvT" }: { initial?: MatchupConfig; matchup?: MatchupKey }) {
  const [config, setConfig] = useState(initial);
  return (
    <>
      <DrawSwitches matchup={matchup} config={config} onChange={setConfig} />
      <UnitDrawSettings matchup={matchup} config={config} onChange={setConfig} />
      <output data-testid="config">{JSON.stringify(config)}</output>
    </>
  );
}

function current(): MatchupConfig {
  return JSON.parse(screen.getByTestId("config").textContent ?? "{}") as MatchupConfig;
}

function expand(buildName = "PvT - Build Alpha") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(buildName) }));
}

describe("the two draw switches", () => {
  it("turn the build and unit draws on and off independently", () => {
    render(<Harness initial={{ ...emptyMatchupConfig() }} matchup="TvZ" />);
    expect(screen.getByText("Nothing is drawn for TvZ.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Draw opening units in TvZ" }));
    expect(current()).toMatchObject({ enabled: false, unitRandomizerEnabled: true });
    expect(screen.getByText("Each TvZ game draws opening units, for whatever build you play.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Draw a build order in TvZ" }));
    fireEvent.click(screen.getByRole("switch", { name: "Draw opening units in TvZ" }));
    expect(current()).toMatchObject({ enabled: true, unitRandomizerEnabled: false });
  });

  it("gives a matchup its own default units the first time its unit draw turns on", () => {
    render(<Harness initial={{ ...emptyMatchupConfig() }} matchup="ZvT" />);
    fireEvent.click(screen.getByRole("switch", { name: "Draw opening units in ZvT" }));
    expect(current().units?.units.map((unit) => unit.id)).toEqual([...MATCHUP_UNIT_POOLS.ZvT]);
  });

  it("names every mode in a sentence", () => {
    const off = emptyMatchupConfig();
    expect(drawSummary("PvP", { ...off, enabled: true, unitRandomizerEnabled: true })).toBe("Each PvP game draws a build, then its opening units.");
    expect(drawSummary("PvP", { ...off, enabled: true })).toBe("Each PvP game draws a build.");
  });
});

describe("race, then matchup", () => {
  it("keeps the opponent when the race changes and labels what each matchup draws", () => {
    const onSelect = vi.fn();
    const config = defaultRandomizerConfig();
    config.matchups.TvZ = { ...config.matchups.TvZ, unitRandomizerEnabled: true,
      units: { gateCount: 1, useCustomWeights: false, units: [{ id: "marine", weight: 1 }] } };
    render(<MatchupSelector config={config} active="PvZ" onSelect={onSelect} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      expect.stringContaining("PvP"), expect.stringContaining("PvT"), expect.stringContaining("PvZ"),
    ]);
    fireEvent.click(screen.getByRole("radio", { name: /Terran/ }));
    expect(onSelect).toHaveBeenCalledWith("TvZ");
    expect(drawsLabel(config.matchups.TvZ)).toBe("Units");
    expect(drawsLabel(config.matchups.PvZ)).toBe("Off");
  });
});

describe("opening units", () => {
  it("edits the matchup's own units for a units-only draw", () => {
    render(<Harness initial={{ ...emptyMatchupConfig(), unitRandomizerEnabled: true }} matchup="TvZ" />);
    expect(screen.getByText("The draw when no build is drawn.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /in the opening draw for TvZ$/ })).toHaveLength(MATCHUP_UNIT_POOLS.TvZ.length);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include Banshee in the opening draw for TvZ" }));
    expect(current().units?.units.map((unit) => unit.id)).toEqual(MATCHUP_UNIT_POOLS.TvZ.filter((id) => id !== "banshee"));
    fireEvent.click(screen.getByRole("radio", { name: "2 units for TvZ" }));
    expect(current().units?.gateCount).toBe(2);
  });

  it("keeps only one selected-build editor expanded", () => {
    const base = buildConfig();
    render(<Harness initial={{ ...base, builds: [...base.builds, { ...base.builds[0], id: "build-beta", name: "PvT - Build Beta" }] }} />);
    expand();
    expect(screen.getByRole("button", { name: /PvT - Build Alpha/ }).getAttribute("aria-expanded")).toBe("true");
    expand("PvT - Build Beta");
    expect(screen.getByRole("button", { name: /PvT - Build Alpha/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /PvT - Build Beta/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("updates a build's 1 Gate / 2 Gates choice", () => {
    render(<Harness />);
    expand();
    fireEvent.click(screen.getByRole("radio", { name: "2 Gates for PvT - Build Alpha" }));
    expect(current().builds[0].openingUnits?.gateCount).toBe(2);
    expect(screen.getByText(/Picks are independent, so repeats are possible/)).toBeTruthy();
  });

  it("shows live normalized custom odds with unique accessible sliders", () => {
    render(<Harness initial={buildConfig({ builds: [{ ...buildConfig().builds[0], openingUnits: {
      gateCount: 1, useCustomWeights: true, units: [{ id: "zealot", weight: 1 }, { id: "stalker", weight: 3 }],
    } }] })} />);
    expand();
    const panel = within(document.getElementById("opening-units-panel-build-alpha") as HTMLElement);
    expect(panel.getByText("25.0% chance · Gateway")).toBeTruthy();
    expect(panel.getByText("75.0% chance · Gateway")).toBeTruthy();
    const zealot = panel.getByRole("slider", { name: "Selection weight for Zealot in PvT - Build Alpha" });
    fireEvent.change(zealot, { target: { value: "3" } });
    expect(panel.getAllByText("50.0% chance · Gateway")).toHaveLength(2);
  });

  it("does not allow the last selected unit to be removed", () => {
    render(<Harness initial={buildConfig({ builds: [{ ...buildConfig().builds[0], openingUnits: {
      gateCount: 1, useCustomWeights: false, units: [{ id: "zealot", weight: 1 }],
    } }] })} />);
    expand();
    const zealot = screen.getByRole("checkbox", { name: "Include Zealot in the opening draw for PvT - Build Alpha" }) as HTMLInputElement;
    expect(zealot.disabled).toBe(true);
  });

  it("shows a Terran build saved without units as drawing with its matchup's", () => {
    const config = buildConfig({ builds: [{ id: "t", name: "TvZ - Old", race: "Terran", source: "catalog", weight: 1 }],
      units: { gateCount: 2, useCustomWeights: false, units: [{ id: "reaper", weight: 1 }] } });
    render(<Harness initial={config} matchup="TvZ" />);
    expect(screen.getByText("Same as the matchup")).toBeTruthy();
    expand("TvZ - Old");
    fireEvent.click(screen.getByRole("radio", { name: "1 unit for TvZ - Old" }));
    expect(current().builds[0].openingUnits).toEqual({ gateCount: 1, useCustomWeights: false, units: [{ id: "reaper", weight: 1 }] });
  });

  it("says when the unit draw is off, and keeps the settings editable", () => {
    render(<Harness initial={{ ...buildConfig(), unitRandomizerEnabled: false }} />);
    expect(screen.getByText(/Draw opening units is off for PvT/)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Include Adept in the opening draw for PvT" })).toBeTruthy();
  });
});

describe("the live preview", () => {
  it("spins units drawn alone and says what is missing otherwise", () => {
    const units = { gateCount: 1 as const, useCustomWeights: false, units: [{ id: "roach" as const, weight: 1 }] };
    expect(previewBlocker({ ...emptyMatchupConfig(), unitRandomizerEnabled: true, units })).toBeNull();
    expect(previewBlocker(emptyMatchupConfig())).toMatch(/Turn on Draw a build order or Draw opening units/);
    expect(previewBlocker({ ...emptyMatchupConfig(), enabled: true })).toMatch(/Add at least one build/);
    expect(previewBlocker({ ...emptyMatchupConfig(), unitRandomizerEnabled: true })).toMatch(/Select at least one unit/);
  });
});

describe("the build pool", () => {
  it("seeds a newly selected build with the unit draw its name implies, for every race", () => {
    const onChange = vi.fn();
    render(
      <MatchupBuildPicker
        matchup="PvT"
        config={buildConfig({ builds: [] })}
        customBuilds={[{ slug: "one-gate-custom", name: "My 1 Gate Custom", race: "Protoss", vsRace: "Terran" }]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle My 1 Gate Custom" }));
    const protoss = (onChange.mock.calls[0][0] as MatchupConfig).builds[0];
    expect(protoss.openingUnits).toEqual({
      gateCount: 1, useCustomWeights: false,
      units: ["zealot", "stalker", "sentry", "adept"].map((id) => ({ id, weight: 1 })),
    });
    cleanup();
    render(<MatchupBuildPicker matchup="TvZ" config={buildConfig({ builds: [] })} customBuilds={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle TvZ - Reaper Hellion Expand" }));
    const terran = (onChange.mock.calls[1][0] as MatchupConfig).builds[0];
    expect(terran.openingUnits).toMatchObject({ gateCount: 2, units: [{ id: "reaper" }, { id: "hellion" }] });
  });

  it("says when the build draw is off, and keeps the pool", () => {
    render(<MatchupBuildPicker matchup="PvT" config={buildConfig({ enabled: false })} customBuilds={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/Draw a build order is off for PvT/)).toBeTruthy();
  });

  it("pages and searches the custom pool without losing selections on other pages", () => {
    const onChange = vi.fn();
    const nextPage = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <MatchupBuildPicker
        matchup="TvZ"
        config={buildConfig({ builds: [{ id: "custom:earlier", name: "Earlier selection", race: "Terran", source: "custom", weight: 2 }] })}
        customBuilds={[{ slug: "older", name: "Older custom build", race: "Terran", vsRace: "Any" }]}
        search=""
        onSearchChange={onSearchChange}
        customBuildPage={{
          pageNumber: 3, pageStart: 100, data: { items: [], total: 160 },
          hasPrevious: true, hasNext: true, isLoading: false, isValidating: false,
          error: undefined, previousPage: vi.fn(), nextPage,
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Page 3 of 4 · builds 101–101 of 160")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(nextPage).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search custom builds for randomizer" }), { target: { value: "Older" } });
    expect(onSearchChange).toHaveBeenCalledWith("Older");
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle Older custom build" }));
    const next = onChange.mock.calls[0][0] as MatchupConfig;
    expect(next.builds.map((build) => build.id)).toEqual(["custom:earlier", "custom:older"]);
    expect(next.builds[0].weight).toBe(2);
  });
});
