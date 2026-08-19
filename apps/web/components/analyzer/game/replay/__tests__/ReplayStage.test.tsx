import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReplayStage } from "../ReplayStage";
import { payload, v4Payload } from "./fixtures";

/**
 * jsdom has no 2D canvas context, so ``MapReplayer``'s draw loop bails
 * on its own ``if (!ctx) return`` guard — exactly the path the existing
 * replayer tests already rely on. Everything asserted here is the HUD
 * DOM around that canvas.
 */

describe("ReplayStage", () => {
  it("renders the stage, both rails and the transport dock", () => {
    render(<ReplayStage playback={payload()} />);
    expect(screen.getByTestId("replay-stage")).toBeTruthy();
    expect(screen.getByTestId("replay-top-bar")).toBeTruthy();
    expect(screen.getByTestId("replay-production-rail")).toBeTruthy();
    expect(screen.getByTestId("replay-build-order-rail")).toBeTruthy();
    expect(screen.getByTestId("replay-transport")).toBeTruthy();
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
  });

  it("hides the replayer's own transport chrome when it drives the clock", () => {
    render(<ReplayStage playback={payload()} />);
    // One scrubber and one play button on the page, not two.
    expect(screen.getAllByRole("slider", { name: /playback position/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^play$/i })).toHaveLength(1);
    expect(screen.queryByTestId("loss-panel-you")).toBeFalsy();
  });

  it("falls back to You / Opponent and uses supplied names when given", () => {
    const { unmount } = render(<ReplayStage playback={payload()} />);
    const bar = screen.getByTestId("replay-top-bar");
    expect(within(bar).getByText("You")).toBeTruthy();
    expect(within(bar).getByText("Opponent")).toBeTruthy();
    unmount();

    render(<ReplayStage playback={payload()} myName="Serral" oppName="Maru" />);
    const named = screen.getByTestId("replay-top-bar");
    expect(within(named).getByText("Serral")).toBeTruthy();
    expect(within(named).getByText("Maru")).toBeTruthy();
  });

  it("starts at 0:00 and shows the map name", () => {
    render(<ReplayStage playback={payload()} />);
    const bar = screen.getByTestId("replay-top-bar");
    expect(within(bar).getByText("0:00")).toBeTruthy();
    expect(within(bar).getByText("Harness Station")).toBeTruthy();
  });

  it("omits minerals and gas when no banked series is supplied", () => {
    render(<ReplayStage playback={payload()} />);
    const bar = screen.getByTestId("replay-top-bar");
    expect(within(bar).queryByTitle(/minerals banked/i)).toBeFalsy();
    expect(within(bar).queryByTitle(/gas banked/i)).toBeFalsy();
  });

  it("shows minerals and gas when the host hands over a banked series", () => {
    render(
      <ReplayStage
        playback={payload()}
        banked={{
          me: [
            [0, 400, 100],
            [600, 400, 100],
          ],
          opp: [
            [0, 250, 50],
            [600, 250, 50],
          ],
        }}
      />,
    );
    const bar = screen.getByTestId("replay-top-bar");
    expect((within(bar).getByTitle(/You — minerals banked/i)).textContent ?? "").toContain("400");
    expect((within(bar).getByTitle(/Opponent — gas banked/i)).textContent ?? "").toContain("50");
  });

  it("cycles the speed button through 1× / 4× / 8× / 16×", () => {
    render(<ReplayStage playback={payload()} />);
    const speed = screen.getByRole("button", { name: /playback speed/i });
    expect((speed).textContent ?? "").toContain("8×");
    fireEvent.click(speed);
    expect((speed).textContent ?? "").toContain("16×");
    fireEvent.click(speed);
    expect((speed).textContent ?? "").toContain("1×");
  });

  it("seeks when a build-order row is activated", () => {
    render(<ReplayStage playback={payload()} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Spawning Pool.*16 supply.*0:33/i }),
    );
    expect(
      within(screen.getByTestId("replay-transport")).getByText("0:33 / 10:00"),
    ).toBeTruthy();
  });

  it("gives every timeline marker a focusable button with a real name", () => {
    render(<ReplayStage playback={payload()} />);
    const strip = screen.getByRole("group", { name: /notable moments/i });
    const dots = within(strip).getAllByRole("button");
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      // jest-dom is not installed in this repo (plain vitest assertions
      // only), so read the accessible name off the node directly.
      const name = dot.getAttribute("aria-label") ?? dot.textContent ?? "";
      expect(name).toMatch(/\d+:\d\d · .+/);
    }
    fireEvent.click(dots[0]);
    expect(
      within(screen.getByTestId("replay-transport")).getByText(/2:35 \/ 10:00/),
    ).toBeTruthy();
  });

  it("keeps the scrubber a real range input", () => {
    render(<ReplayStage playback={payload()} />);
    const slider = screen.getByRole("slider", { name: /playback position/i });
    expect((slider).getAttribute("type")).toBe("range");
    expect((slider).getAttribute("max")).toBe("600");
    fireEvent.change(slider, { target: { value: "120" } });
    expect(
      within(screen.getByTestId("replay-transport")).getByText("2:00 / 10:00"),
    ).toBeTruthy();
  });

  it("renders the derived production queue with a countdown", () => {
    render(<ReplayStage playback={payload()} />);
    const slider = screen.getByRole("slider", { name: /playback position/i });
    fireEvent.change(slider, { target: { value: "190" } });
    const rail = screen.getByTestId("replay-production-rail");
    // Roach lands at 200, so it is 10 s out at t=190.
    expect(within(rail).getByTitle(/Roach — 10s remaining/)).toBeTruthy();
  });

  it("says Idle rather than inventing a queue when nothing is building", () => {
    const rail = () => screen.getByTestId("replay-production-rail");
    render(<ReplayStage playback={payload()} />);
    fireEvent.change(screen.getByRole("slider", { name: /playback position/i }), {
      target: { value: "400" },
    });
    expect(within(rail()).getAllByText("Idle").length).toBeGreaterThan(0);
  });

  it("renders upgrades as an explicit empty state, never a guess", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = screen.getByTestId("replay-production-rail");
    const upgrades = within(rail).getByRole("region", { name: /upgrades/i });
    expect(within(upgrades).getByText(/not tracked/i)).toBeTruthy();
    expect(
      within(upgrades).getByText(/no upgrade events/i),
    ).toBeTruthy();
  });

  it("switches the production rail to the On Field tab", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = screen.getByTestId("replay-production-rail");
    fireEvent.click(within(rail).getByRole("tab", { name: /on field/i }));
    expect((within(rail).getByRole("tab", { name: /on field/i })).getAttribute("aria-selected")).toBe("true");
    expect(within(rail).getByText(/losses to/i)).toBeTruthy();
  });

  it("filters the build feed by side and by worker production", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = screen.getByTestId("replay-build-order-rail");
    // Workers are off by default.
    expect(within(rail).queryByRole("button", { name: /^Drone,/ })).toBeFalsy();
    fireEvent.click(within(rail).getByRole("button", { name: /worker production/i }));
    expect(within(rail).getAllByRole("button", { name: /^Drone,/ }).length).toBeGreaterThan(0);

    fireEvent.click(within(rail).getByRole("button", { name: "You" }));
    expect(within(rail).queryByRole("button", { name: /^Marine,/ })).toBeFalsy();
  });

  it("hides a rail from the settings popover", () => {
    render(<ReplayStage playback={payload()} />);
    fireEvent.click(screen.getByRole("button", { name: /display settings/i }));
    fireEvent.click(screen.getByLabelText("Build order rail"));
    expect(screen.queryByTestId("replay-build-order-rail")).toBeFalsy();
    expect(screen.getByTestId("replay-production-rail")).toBeTruthy();
  });

  it("renders a v4 payload that carries no casts at all", () => {
    const pb = v4Payload();
    expect(pb.casts).toBeUndefined();
    expect(() => render(<ReplayStage playback={pb} />)).not.toThrow();
    expect(screen.getByTestId("replay-stage")).toBeTruthy();
    const strip = screen.getByRole("group", { name: /notable moments/i });
    // Only the battle marker survives; no cast dots.
    expect(within(strip).getAllByRole("button")).toHaveLength(1);
  });

  it("follows the playhead: no late-game rows before they happen", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = () => screen.getByTestId("replay-build-order-rail");
    // Marauder lands at 3:30, well past the lookahead window at t=0.
    expect(within(rail()).queryByRole("button", { name: /^Marauder,/ })).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: /playback position/i }), {
      target: { value: "220" },
    });
    expect(
      within(rail()).getByRole("button", { name: /^Marauder,.*3:30/ }),
    ).toBeTruthy();
  });

  it("shows a heuristic opening when the host passes no build name", () => {
    render(<ReplayStage playback={payload()} />);
    const rail = screen.getByTestId("replay-build-order-rail");
    expect(within(rail).getByText(/Opening:/)).toBeTruthy();
    expect(within(rail).queryByText(/% match/)).toBeFalsy();
  });

  it("shows the host's build name and match percentage when given", () => {
    render(
      <ReplayStage playback={payload()} buildName="17 Hatch 17 Pool" buildMatchPct={82} />,
    );
    const rail = screen.getByTestId("replay-build-order-rail");
    expect(within(rail).getByText("17 Hatch 17 Pool")).toBeTruthy();
    expect(within(rail).getByText("82% match")).toBeTruthy();
    expect(within(rail).queryByText(/Opening:/)).toBeFalsy();
  });
});
