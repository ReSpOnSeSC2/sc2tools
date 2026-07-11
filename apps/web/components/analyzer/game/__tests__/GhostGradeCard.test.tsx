import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ArmGhostFromLogButton, GhostGradeCard } from "../GhostGradeCard";
import {
  GHOST_BUILD_STORAGE_KEY,
  GHOST_BUILD_VERSION,
  encodeGhostTarget,
  readArmedGhostTarget,
  type GhostTarget,
} from "@/lib/ghostBuild";

const TARGET: GhostTarget = {
  v: GHOST_BUILD_VERSION,
  name: "PvT Blink opener",
  steps: [
    { supply: 14, t: 17, name: "Pylon" },
    { supply: 16, t: 40, name: "Gateway" },
    { supply: 20, t: 95, name: "TwilightCouncil" },
  ],
};

/** Executed log: Pylon on time, Gateway +8s, Twilight cut. */
const FIXTURE_LOG = [
  "[0:12] Probe",
  "[0:17] Pylon",
  "[0:48] Gateway",
  "[1:40] Assimilator",
];

function armFixture(target: GhostTarget = TARGET) {
  window.localStorage.setItem(
    GHOST_BUILD_STORAGE_KEY,
    encodeGhostTarget(target)!,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("GhostGradeCard", () => {
  it("renders nothing when no target is armed", () => {
    const { container } = render(<GhostGradeCard buildLog={FIXTURE_LOG} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the game has no build log", () => {
    armFixture();
    const { container } = render(<GhostGradeCard buildLog={null} />);
    expect(container.firstChild).toBeNull();
    const empty = render(<GhostGradeCard buildLog={[]} />);
    expect(empty.container.firstChild).toBeNull();
  });

  it("renders nothing when localStorage holds a tampered value", () => {
    window.localStorage.setItem(GHOST_BUILD_STORAGE_KEY, "!!corrupt!!");
    const { container } = render(<GhostGradeCard buildLog={FIXTURE_LOG} />);
    expect(container.firstChild).toBeNull();
  });

  it("grades the executed log against the armed target", () => {
    armFixture();
    render(<GhostGradeCard buildLog={FIXTURE_LOG} />);

    expect(screen.getByTestId("ghost-grade-card")).toBeTruthy();
    expect(screen.getByText("Ghost Build grade")).toBeTruthy();
    // 2/3 matched (Twilight cut), avg |drift| = (0+8)/2 = 4s → C band
    // (matchRate 0.67 < 0.75).
    expect(screen.getByLabelText("Grade C")).toBeTruthy();
    expect(screen.getByText("vs PvT Blink opener")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("4s")).toBeTruthy(); // avg drift
    expect(screen.getByText("8s")).toBeTruthy(); // max drift
    // First divergence = the cut TwilightCouncil.
    expect(screen.getByText("TwilightCouncil")).toBeTruthy();
    expect(screen.getByText(/never executed/)).toBeTruthy();
  });

  it("grades a perfect run S with no divergence", () => {
    armFixture();
    render(
      <GhostGradeCard
        buildLog={["[0:17] Pylon", "[0:40] Gateway", "[1:35] TwilightCouncil"]}
      />,
    );
    expect(screen.getByLabelText("Grade S")).toBeTruthy();
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText(/No divergence/)).toBeTruthy();
  });

  it("expands the per-step breakdown on demand (collapsed by default)", () => {
    armFixture();
    render(<GhostGradeCard buildLog={FIXTURE_LOG} />);
    // Collapsed: no per-step rows yet.
    expect(screen.queryByText(/16 Gateway/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /per-step breakdown/i }),
    );
    expect(screen.getByText(/14 Pylon/)).toBeTruthy();
    expect(screen.getByText(/16 Gateway/)).toBeTruthy();
    expect(screen.getByText("+8s")).toBeTruthy();
    expect(screen.getByText("missed")).toBeTruthy();
  });

  it("disarm clears storage and unmounts the card", () => {
    armFixture();
    render(<GhostGradeCard buildLog={FIXTURE_LOG} />);
    fireEvent.click(screen.getByRole("button", { name: "Disarm" }));
    expect(screen.queryByTestId("ghost-grade-card")).toBeNull();
    expect(window.localStorage.getItem(GHOST_BUILD_STORAGE_KEY)).toBeNull();
  });
});

describe("ArmGhostFromLogButton", () => {
  it("arms the build log as the ghost target", () => {
    render(
      <ArmGhostFromLogButton name="Roach opener" lines={FIXTURE_LOG} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /arm this build/i }));
    const armed = readArmedGhostTarget();
    expect(armed).not.toBeNull();
    expect(armed!.name).toBe("Roach opener");
    // Probe excluded; Pylon/Gateway/Assimilator armed with their times.
    expect(armed!.steps).toEqual([
      { supply: null, t: 17, name: "Pylon" },
      { supply: null, t: 48, name: "Gateway" },
      { supply: null, t: 100, name: "Assimilator" },
    ]);
  });

  it("makes the grade card appear on the same page via the armed event", () => {
    render(
      <>
        <ArmGhostFromLogButton name="Roach opener" lines={FIXTURE_LOG} />
        <GhostGradeCard buildLog={FIXTURE_LOG} />
      </>,
    );
    expect(screen.queryByTestId("ghost-grade-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /arm this build/i }));
    // Arming this game's own log grades it against itself — a perfect S.
    expect(screen.getByTestId("ghost-grade-card")).toBeTruthy();
    expect(screen.getByLabelText("Grade S")).toBeTruthy();
  });

  it("does not arm anything when the log has no timed steps", () => {
    render(<ArmGhostFromLogButton name="Empty" lines={["nonsense"]} />);
    fireEvent.click(screen.getByRole("button", { name: /arm this build/i }));
    expect(readArmedGhostTarget()).toBeNull();
  });
});
