import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MatchupConfig,
  MatchupKey,
} from "@/lib/randomizer/types";
import { BuildUnitRollEditor } from "./BuildUnitRollEditor";
import { MatchupBuildPicker } from "./MatchupBuildPicker";

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

function Harness({
  initial = buildConfig(),
  matchup = "PvT",
}: {
  initial?: MatchupConfig;
  matchup?: MatchupKey;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <BuildUnitRollEditor
      matchup={matchup}
      config={config}
      onChange={setConfig}
    />
  );
}

function expand(buildName = "PvT - Build Alpha") {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(buildName) }));
}

describe("BuildUnitRollEditor", () => {
  it("shows the staged reveal explanation and shipped SC2 unit icons", () => {
    const { container } = render(<Harness />);

    expect(screen.getByText("Build chosen")).toBeTruthy();
    expect(screen.getByText("Screen clears")).toBeTruthy();
    expect(screen.getByText("Unit draw")).toBeTruthy();

    const icon = container.querySelector(
      'img[src*="/icons/sc2/units/zealot.png"]',
    );
    expect(icon).toBeTruthy();
  });

  it("keeps only one selected-build editor expanded", () => {
    const first = buildConfig().builds[0];
    const second = {
      ...first,
      id: "build-beta",
      name: "PvT - Build Beta",
    };
    render(<Harness initial={buildConfig({ builds: [first, second] })} />);

    const alpha = screen.getByRole("button", { name: /PvT - Build Alpha/ });
    const beta = screen.getByRole("button", { name: /PvT - Build Beta/ });
    fireEvent.click(alpha);
    expect(alpha.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(beta);
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    expect(beta.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("Opening production")).toHaveLength(1);
  });

  it("updates the per-build 1 Gate / 2 Gates choice", () => {
    render(<Harness />);
    expand();

    const oneGate = screen.getByRole("radio", {
      name: "1 Gateway for PvT - Build Alpha",
    }) as HTMLInputElement;
    const twoGates = screen.getByRole("radio", {
      name: "2 Gateways for PvT - Build Alpha",
    }) as HTMLInputElement;
    expect(oneGate.checked).toBe(true);

    fireEvent.click(twoGates);
    expect(twoGates.checked).toBe(true);
    expect(
      screen.getByText(/Picks are independent, so repeats are possible/),
    ).toBeTruthy();
  });

  it("shows live normalized custom odds with unique accessible sliders", () => {
    const initial = buildConfig();
    initial.builds[0] = {
      ...initial.builds[0],
      openingUnits: {
        gateCount: 1,
        useCustomWeights: true,
        units: [
          { id: "zealot", weight: 1 },
          { id: "stalker", weight: 3 },
        ],
      },
    };
    render(<Harness initial={initial} />);
    expand();

    expect(screen.getByText("25.0% chance")).toBeTruthy();
    expect(screen.getByText("75.0% chance")).toBeTruthy();
    const zealotSlider = screen.getByRole("slider", {
      name: "Selection weight for Zealot in PvT - Build Alpha",
    });
    expect(zealotSlider.getAttribute("aria-valuetext")).toBe(
      "1.0 weight, 25.0 percent selection chance",
    );

    fireEvent.change(zealotSlider, { target: { value: "3" } });
    expect(screen.getAllByText("50.0% chance")).toHaveLength(2);
    expect(zealotSlider.getAttribute("aria-valuetext")).toBe(
      "3.0 weight, 50.0 percent selection chance",
    );
  });

  it("does not allow the last eligible unit to be removed", () => {
    const initial = buildConfig();
    initial.builds[0] = {
      ...initial.builds[0],
      openingUnits: {
        gateCount: 1,
        useCustomWeights: false,
        units: [{ id: "zealot", weight: 1 }],
      },
    };
    render(<Harness initial={initial} />);
    expand();

    const zealot = screen.getByRole("checkbox", {
      name: "Include Zealot in the opening draw for PvT - Build Alpha",
    }) as HTMLInputElement;
    expect(zealot.checked).toBe(true);
    expect(zealot.disabled).toBe(true);
  });

  it("exposes a matchup-level master switch", () => {
    render(<Harness />);
    const master = screen.getByRole("switch", {
      name: "Randomize opening Gateway units for PvT",
    }) as HTMLButtonElement;
    expect(master.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(master);
    expect(master.getAttribute("aria-checked")).toBe("false");
  });

  it("does not render for a non-Protoss matchup", () => {
    const { container } = render(
      <Harness
        matchup="TvZ"
        initial={buildConfig({
          builds: [],
          unitRandomizerEnabled: false,
        })}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("seeds newly selected Protoss builds with a complete opening pool", () => {
    const onChange = vi.fn();
    render(
      <MatchupBuildPicker
        matchup="PvT"
        config={buildConfig({ builds: [] })}
        customBuilds={[
          {
            slug: "one-gate-custom",
            name: "My 1 Gate Custom",
            race: "Protoss",
            vsRace: "Terran",
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Toggle My 1 Gate Custom" }),
    );
    const next = onChange.mock.calls[0][0] as MatchupConfig;
    const selected = next.builds.find(
      (build) => build.id === "custom:one-gate-custom",
    );
    expect(selected?.openingUnits?.gateCount).toBe(1);
    expect(selected?.openingUnits?.useCustomWeights).toBe(false);
    expect(selected?.openingUnits?.units.map((unit) => unit.id)).toEqual([
      "zealot",
      "stalker",
      "sentry",
      "adept",
    ]);
  });
});
