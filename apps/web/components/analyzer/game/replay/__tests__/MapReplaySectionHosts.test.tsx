import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rawPayload } from "./fixtures";

// vitest.config.ts sets globals:false, so React Testing Library never
// registers its automatic cleanup -- without this every render stays
// mounted and the next query matches the previous test's DOM too.
afterEach(() => cleanup());

/**
 * The two presentations ``MapReplaySection`` picks between: the
 * full-page HUD stage, and the compact drilldown that must keep
 * rendering exactly what it rendered before the HUD existed.
 *
 * Named ``MapReplaySectionHosts`` rather than ``MapReplaySection`` so it
 * sits alongside the HUD it covers and cannot collide with the suite
 * that already tests this component's loading / 404 states.
 */

const api = vi.hoisted(() => ({
  result: { data: undefined, isLoading: false } as {
    data: unknown;
    isLoading: boolean;
  },
}));

vi.mock("@/lib/clientApi", () => ({
  useApi: () => api.result,
}));

const { MapReplaySection } = await import("../../MapReplaySection");

describe("MapReplaySection hosts", () => {
  beforeEach(() => {
    api.result = { data: rawPayload(), isLoading: false };
  });

  it("seeks when delayed playback arrives, stays paused, and preserves user scrubbing on refresh", () => {
    api.result = { data: undefined, isLoading: true };
    const view = render(<MapReplaySection gameId="g1" initialTimeSec={360} />);
    api.result = { data: rawPayload(), isLoading: false };
    view.rerender(<MapReplaySection gameId="g1" initialTimeSec={360} />);
    const slider = () => screen.getByRole("slider", { name: /playback position/i }) as HTMLInputElement;
    expect(slider().value).toBe("360");
    expect(screen.getByRole("button", { name: /^play$/i })).toBeTruthy();
    fireEvent.change(slider(), { target: { value: "420" } });
    api.result = { data: rawPayload(), isLoading: false };
    view.rerender(<MapReplaySection gameId="g1" initialTimeSec={360} />);
    expect(slider().value).toBe("420");
  });

  it("clamps a linked timestamp to playback duration and resets on game or timestamp navigation", () => {
    const view = render(<MapReplaySection gameId="g1" initialTimeSec={999999} />);
    const slider = () => screen.getByRole("slider", { name: /playback position/i }) as HTMLInputElement;
    expect(slider().value).toBe("600");
    view.rerender(<MapReplaySection gameId="g1" initialTimeSec={120} />);
    expect(slider().value).toBe("120");
    fireEvent.change(slider(), { target: { value: "180" } });
    view.rerender(<MapReplaySection gameId="g2" initialTimeSec={120} />);
    expect(slider().value).toBe("120");
    view.rerender(<MapReplaySection gameId="g3" />);
    expect(slider().value).toBe("0");
  });

  it("initializes the compact replay at the linked timestamp too", () => {
    render(<MapReplaySection gameId="g1" compact initialTimeSec={240} />);
    const slider = screen.getByRole("slider", { name: /playback position/i }) as HTMLInputElement;
    expect(slider.value).toBe("240");
    expect(screen.getByRole("button", { name: "▶ Play" })).toBeTruthy();
  });

  it("renders the HUD stage with both rails on the full-page host", () => {
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByTestId("replay-stage")).toBeTruthy();
    expect(screen.getByTestId("replay-top-bar")).toBeTruthy();
    expect(screen.getByTestId("replay-production-rail")).toBeTruthy();
    expect(screen.getByTestId("replay-build-order-rail")).toBeTruthy();
    expect(screen.getByTestId("replay-transport")).toBeTruthy();
  });

  it("passes player identity through to the top bar", () => {
    render(<MapReplaySection gameId="g1" myName="Serral" oppName="Maru" />);
    // Scoped: the names also label the rails' side switches.
    const bar = within(screen.getByTestId("replay-top-bar"));
    expect(bar.getByText("Serral")).toBeTruthy();
    expect(bar.getByText("Maru")).toBeTruthy();
  });

  it("keeps the compact drilldown as map + transport only, no rails", () => {
    render(<MapReplaySection gameId="g1" compact />);
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
    expect(screen.queryByTestId("replay-stage")).toBeFalsy();
    expect(screen.queryByTestId("replay-production-rail")).toBeFalsy();
    expect(screen.queryByTestId("replay-build-order-rail")).toBeFalsy();
    // …and it keeps the units-lost panels the drilldown has always had.
    expect(screen.getByTestId("loss-panel-you")).toBeTruthy();
    expect(screen.getByTestId("loss-panel-opponent")).toBeTruthy();
  });

  it("still hides entirely in the compact host when there is no playback", () => {
    api.result = { data: undefined, isLoading: false };
    const { container } = render(<MapReplaySection gameId="g1" compact />);
    expect((container).innerHTML).toBe("");
  });

  it("still shows the re-sync hint on the full-page host when there is no playback", () => {
    api.result = { data: undefined, isLoading: false };
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByText(/No playback data for this game/i)).toBeTruthy();
  });

  it("still shows a skeleton while loading", () => {
    api.result = { data: undefined, isLoading: true };
    render(<MapReplaySection gameId="g1" />);
    expect(screen.getByLabelText("Loading map replay")).toBeTruthy();
  });
});
