import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TechPathAlternatives } from "../TechPathAlternatives";

afterEach(() => cleanup());

describe("TechPathAlternatives", () => {
  it("renders alternatives sorted by frequency with delta vs focal", () => {
    render(
      <TechPathAlternatives
        techPath={{
          pathId: "robo_twilight",
          pathLabel: "Twilight + Robo",
          buildingsInPath: ["RoboticsFacility", "TwilightCouncil"],
          pathFrequency: 0.34,
          pathWinRate: 0.61,
          pathWinRateCI: [0.54, 0.67],
          sampleSize: 142,
          score: 1,
          alternatives: [
            {
              pathId: "stargate_only",
              label: "Stargate only",
              winRate: 0.42,
              winRateCI: [0.36, 0.48],
              frequency: 0.21,
              sampleSize: 87,
            },
          ],
          transitions: [
            { addedBuilding: "TemplarArchive", afterSec: 60, frequencyAmongWinners: 0.41 },
          ],
        }}
      />,
    );
    expect(screen.getByText(/Stargate only/)).toBeTruthy();
    expect(screen.getByText(/42%/)).toBeTruthy();
    expect(screen.getByText(/-19%/)).toBeTruthy();
    expect(screen.getByText(/TemplarArchive/)).toBeTruthy();
  });

  it("low-confidence badge appears when CI is wide", () => {
    render(
      <TechPathAlternatives
        techPath={{
          pathId: "p",
          pathLabel: "Test",
          buildingsInPath: [],
          pathFrequency: 0.5,
          pathWinRate: 0.5,
          pathWinRateCI: [0.4, 0.6],
          sampleSize: 50,
          score: 0,
          alternatives: [
            {
              pathId: "alt",
              label: "Risky alt",
              winRate: 0.55,
              winRateCI: [0.1, 0.9],
              frequency: 0.1,
              sampleSize: 5,
            },
          ],
          transitions: [],
        }}
      />,
    );
    expect(screen.getByText(/Low confidence/i)).toBeTruthy();
  });

  it("shows empty state when techPath is null", () => {
    render(<TechPathAlternatives techPath={null} />);
    expect(screen.getByText(/No tech-path data/i)).toBeTruthy();
  });
});
