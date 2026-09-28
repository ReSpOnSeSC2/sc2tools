import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MapReplayer } from "@/components/analyzer/game/MapReplayer";
import { ReplayStage } from "@/components/analyzer/game/replay/ReplayStage";
import { TransportDock } from "@/components/analyzer/game/replay/TransportDock";
import { payload } from "@/components/analyzer/game/replay/__tests__/fixtures";
import { TimeChip } from "../TimeChip";

afterEach(() => cleanup());

/**
 * The replayer seams the Replay Review Exchange adds: time chips that
 * seek-and-pause, pins placed from ``onWorldClick``, and the comment
 * marker strip on the transport dock.
 *
 * jsdom geometry (see the replay suite's notes): the fixture's square
 * 200×200 bounds size the canvas to 240×240 at dpr 1 with its rect at
 * (0,0), so ``worldProjection`` gives k = 1.16 and a 4 px pad —
 * clientX/Y 120 is world (100, 100).
 */

describe("time chips", () => {
  it("seeks to the comment's moment", () => {
    const onSeek = vi.fn();
    render(<TimeChip startSec={312} endSec={340} onSeek={onSeek} />);
    const chip = screen.getByRole("button", { name: "Jump to 5:12–5:40 in the replay" });
    fireEvent.click(chip);
    expect(onSeek).toHaveBeenCalledWith(312);
  });

  it("drives the replayer to the new time and pauses it", () => {
    const { rerender } = render(<ReplayStage playback={payload()} />);
    // Start playing, then a time chip asks for 5:12.
    fireEvent.click(screen.getByRole("button", { name: /^play$/i }));
    expect(screen.getByRole("button", { name: /^pause$/i })).toBeTruthy();
    rerender(<ReplayStage playback={payload()} seekRequest={{ t: 312, seq: 1 }} />);
    expect(screen.getByText("5:12 / 10:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^play$/i })).toBeTruthy();
    // MapReplayer receives the same controlled time (its slider mirrors it).
    const slider = screen.getByRole("slider", { name: /playback position/i }) as HTMLInputElement;
    expect(slider.value).toBe("312");
    // The same moment again (a second click on the chip) still seeks.
    fireEvent.change(slider, { target: { value: "20" } });
    expect(screen.getByText("0:20 / 10:00")).toBeTruthy();
    rerender(<ReplayStage playback={payload()} seekRequest={{ t: 312, seq: 2 }} />);
    expect(screen.getByText("5:12 / 10:00")).toBeTruthy();
  });
});

describe("pin placement", () => {
  const canvas = () => screen.getByLabelText(/Map playback of/) as HTMLCanvasElement;

  it("reports the world point and clock time under a click", () => {
    const onWorldClick = vi.fn();
    render(<MapReplayer playback={payload()} time={123} onWorldClick={onWorldClick} />);
    fireEvent.click(canvas(), { clientX: 120, clientY: 120 });
    expect(onWorldClick).toHaveBeenCalledTimes(1);
    const [x, y, t] = onWorldClick.mock.calls[0];
    expect(x).toBeCloseTo(100, 5);
    expect(y).toBeCloseTo(100, 5);
    expect(t).toBe(123);
    // World Y points up: a click near the bottom-left is near (30, 30).
    fireEvent.click(canvas(), { clientX: 38.8, clientY: 201.2 });
    expect(onWorldClick.mock.calls[1][0]).toBeCloseTo(30, 5);
    expect(onWorldClick.mock.calls[1][1]).toBeCloseTo(30, 5);
  });

  it("ignores clicks outside the playable area and drags", () => {
    const onWorldClick = vi.fn();
    HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
    render(<MapReplayer playback={payload()} onWorldClick={onWorldClick} />);
    fireEvent.click(canvas(), { clientX: 1, clientY: 1 });
    expect(onWorldClick).not.toHaveBeenCalled();
    // A drag (pointer travels past the tap slop) never places a pin.
    fireEvent(canvas(), Object.assign(new MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }), { pointerId: 1 }));
    fireEvent(canvas(), Object.assign(new MouseEvent("pointermove", { clientX: 140, clientY: 100, bubbles: true }), { pointerId: 1 }));
    fireEvent(canvas(), Object.assign(new MouseEvent("pointerup", { clientX: 140, clientY: 100, bubbles: true }), { pointerId: 1 }));
    fireEvent.click(canvas(), { clientX: 140, clientY: 100 });
    expect(onWorldClick).not.toHaveBeenCalled();
  });

  it("hit-tests existing pins before placing a new one", () => {
    const onWorldClick = vi.fn();
    const onMarkerClick = vi.fn();
    render(
      <MapReplayer
        playback={payload()}
        onWorldClick={onWorldClick}
        onMarkerClick={onMarkerClick}
        markers={[{ id: "c1", x: 100, y: 100, t: 0, label: "1" }]}
      />,
    );
    fireEvent.click(canvas(), { clientX: 125, clientY: 118 });
    expect(onMarkerClick).toHaveBeenCalledWith("c1");
    expect(onWorldClick).not.toHaveBeenCalled();
  });

  it("ignores pins that aren't drawn at the current time, so a new pin lands there", () => {
    const onWorldClick = vi.fn();
    const onMarkerClick = vi.fn();
    render(
      <MapReplayer
        playback={payload()}
        time={60}
        onWorldClick={onWorldClick}
        onMarkerClick={onMarkerClick}
        markers={[{ id: "late", x: 100, y: 100, t: 460, label: "1" }]}
      />,
    );
    fireEvent.click(canvas(), { clientX: 125, clientY: 118 });
    expect(onMarkerClick).not.toHaveBeenCalled();
    expect(onWorldClick).toHaveBeenCalledTimes(1);
  });

  it("draws numbered pins only near their moment", () => {
    const fillText = vi.fn();
    const ctx = new Proxy(
      { fillText, createRadialGradient: () => ({ addColorStop: vi.fn() }), measureText: () => ({ width: 10 }) } as Record<string, unknown>,
      { get: (target, key: string) => (key in target ? target[key] : vi.fn()) },
    );
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const markers = [{ id: "a", x: 100, y: 100, t: 300, label: "1" }, { id: "b", x: 60, y: 60, t: 10, label: "2" }];
      render(<MapReplayer playback={payload()} time={302} markers={markers} />);
      (frame as unknown as FrameRequestCallback)(16);
      const labels = fillText.mock.calls.map((c) => c[0]);
      expect(labels).toContain("1");
      expect(labels).not.toContain("2");
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("comment marker strip", () => {
  it("renders one button per cluster and hands the cluster to the host", () => {
    const onSeek = vi.fn();
    const onCommentMarker = vi.fn();
    const markers = [
      { id: "cluster-310", t: 312, count: 3, label: "3 comments near 5:12" },
      { id: "cluster-60", t: 61, count: 1, label: "Comment at 1:01" },
    ];
    render(
      <TransportDock
        t={0}
        gameLength={600}
        playing={false}
        speed={8}
        markers={[]}
        phases={[]}
        onSeek={onSeek}
        onPlayingChange={() => {}}
        onSpeedChange={() => {}}
        commentMarkers={markers}
        onCommentMarker={onCommentMarker}
      />,
    );
    const strip = screen.getByTestId("replay-comment-strip");
    const busy = screen.getByRole("button", { name: "3 comments near 5:12. Jump here." });
    expect(strip.contains(busy)).toBe(true);
    expect((busy as HTMLElement).style.left).toBe("52%");
    // Bigger clusters draw bigger markers.
    const single = screen.getByRole("button", { name: "Comment at 1:01. Jump here." }) as HTMLElement;
    expect(Number.parseFloat((busy as HTMLElement).style.width)).toBeGreaterThan(Number.parseFloat(single.style.width));
    fireEvent.click(busy);
    expect(onCommentMarker).toHaveBeenCalledWith(markers[0]);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("falls back to seeking when the host has no handler, and hides when empty", () => {
    const onSeek = vi.fn();
    const { rerender } = render(
      <TransportDock t={0} gameLength={600} playing={false} speed={8} markers={[]} phases={[]} onSeek={onSeek}
        onPlayingChange={() => {}} onSpeedChange={() => {}} commentMarkers={[{ id: "c", t: 90, count: 1, label: "Comment at 1:30" }]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment at 1:30. Jump here." }));
    expect(onSeek).toHaveBeenCalledWith(90);
    rerender(
      <TransportDock t={0} gameLength={600} playing={false} speed={8} markers={[]} phases={[]} onSeek={onSeek}
        onPlayingChange={() => {}} onSpeedChange={() => {}} commentMarkers={[]} />,
    );
    expect(screen.queryByTestId("replay-comment-strip")).toBeNull();
  });
});
