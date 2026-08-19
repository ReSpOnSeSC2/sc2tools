import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MapReplayer } from "../../MapReplayer";
import { payload } from "./fixtures";

/**
 * Guards the ONE change the HUD needed from ``MapReplayer``: optional
 * controlled playback props. The contract is that omitting them leaves
 * the component exactly as it was — every existing call site passes
 * nothing.
 */

describe("MapReplayer playback props", () => {
  it("keeps its own transport, stats line and loss panels when uncontrolled", () => {
    render(<MapReplayer playback={payload()} />);
    expect(screen.getByRole("slider", { name: /playback position/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /▶ Play/ })).toBeTruthy();
    expect(screen.getByRole("group", { name: /playback speed/i })).toBeTruthy();
    expect(screen.getByTestId("loss-panel-you")).toBeTruthy();
    expect(screen.getByTestId("loss-panel-opponent")).toBeTruthy();
  });

  it("scrubs on its own when uncontrolled", () => {
    render(<MapReplayer playback={payload()} />);
    const slider = screen.getByRole("slider", { name: /playback position/i });
    fireEvent.change(slider, { target: { value: "120" } });
    expect((slider as HTMLInputElement).value).toBe(String("120"));
    expect(screen.getByText("2:00 / 10:00")).toBeTruthy();
  });

  it("hides all of its own chrome under hideControls, keeping the canvas", () => {
    render(<MapReplayer playback={payload()} hideControls />);
    expect(screen.queryByRole("slider")).toBeFalsy();
    expect(screen.queryByRole("button", { name: /▶ Play/ })).toBeFalsy();
    expect(screen.queryByTestId("loss-panel-you")).toBeFalsy();
    expect(screen.getByTestId("map-replayer")).toBeTruthy();
    expect(screen.getByRole("button", { name: /zoom in/i })).toBeTruthy();
    // The screen-reader summary is the canvas's only description, so it
    // must survive.
    expect(screen.getByText(/army value/i)).toBeTruthy();
  });

  it("reports scrubs to the host and renders the host's time", () => {
    const onTimeChange = vi.fn();
    const { rerender } = render(
      <MapReplayer playback={payload()} time={0} onTimeChange={onTimeChange} />,
    );
    fireEvent.change(screen.getByRole("slider", { name: /playback position/i }), {
      target: { value: "150" },
    });
    expect(onTimeChange).toHaveBeenCalledWith(150);
    // Controlled: the label only moves once the host feeds the value back.
    expect(screen.getByText("0:00 / 10:00")).toBeTruthy();
    rerender(
      <MapReplayer playback={payload()} time={150} onTimeChange={onTimeChange} />,
    );
    expect(screen.getByText("2:30 / 10:00")).toBeTruthy();
  });

  it("reports play and speed changes to the host", () => {
    const onPlayingChange = vi.fn();
    const onSpeedChange = vi.fn();
    render(
      <MapReplayer
        playback={payload()}
        playing={false}
        onPlayingChange={onPlayingChange}
        speed={8}
        onSpeedChange={onSpeedChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /▶ Play/ }));
    expect(onPlayingChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "16×" }));
    expect(onSpeedChange).toHaveBeenCalledWith(16);
  });

  it("shows the host's playing and speed state, not its own", () => {
    render(<MapReplayer playback={payload()} playing speed={1} />);
    expect(screen.getByRole("button", { name: /❚❚ Pause/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: "1×" })).getAttribute("aria-pressed")).toBe("true");
  });
});
