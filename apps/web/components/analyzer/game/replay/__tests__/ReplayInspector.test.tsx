import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapReplayer } from "../../MapReplayer";
import { payload } from "./fixtures";

vi.mock("@/lib/spriteSheets", () => {
  const anim = { frames: 8, fps: 8, cols: 8, rows: 8, suffix: null, wupc: 2, ax: 128, ay: 128 };
  const sprite = { name: "Marine", meta: { kind: "unit", race: "Terran", frameSize: 256, facings: 8, anims: { Stand: anim, Walk: anim } }, handles: {} };
  return { beginSpriteFrame: vi.fn(), endSpriteFrame: vi.fn(), drawSprite: () => true, hasWalk: () => true,
    resolveSprite: () => sprite, spriteAnim: (_s: unknown, name: string) => ({ name, anim, sprite }), spriteAssetsVersion: () => 0 };
});

let frame: FrameRequestCallback;
const scales: number[] = [];
beforeEach(() => {
  scales.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop: vi.fn() }), scale: (z: number) => { scales.push(z); } }, {
    get(target, key) { return key in target ? target[key as keyof typeof target] : vi.fn(); },
  }) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// The jsdom stage measures 240×240 CSS px: k = 1.16 px per world unit
// with a 4 px pad, so world (30, 30) sits at canvas (38.8, 201.2).
const MARINE_AT = { clientX: 39, clientY: 201 };

function marineGame() {
  return payload({ buildings: [], resources: [], battles: [],
    units: [{ owner: "me", name: "Marine", born: 10, died: 200, wp: [10, 30, 30, 200, 30, 30] }] });
}

describe("click-to-inspect", () => {
  it("opens a unit's details on tap, follows it, and Escape releases the follow before closing", () => {
    render(<MapReplayer playback={marineGame()} time={50} sideLabels={{ me: "Ada" }} />);
    act(() => frame(16));
    const canvas = screen.getByLabelText(/Map playback of/);
    fireEvent.click(canvas, MARINE_AT);
    const card = screen.getByTestId("replay-unit-inspector");
    expect(card.textContent).toContain("Marine");
    expect(card.textContent).toContain("Ada · unit");
    expect(card.textContent).toContain("0:10"); // born
    expect(card.textContent).toContain("3:20"); // died
    expect(card.textContent).toContain("Not recorded"); // tracker payload: no attack data

    fireEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(screen.getByRole("button", { name: "Following" }).getAttribute("aria-pressed")).toBe("true");
    scales.length = 0;
    act(() => frame(32));
    expect(scales[0]).toBe(2.5); // the camera zoomed in on the unit

    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Follow" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByTestId("replay-unit-inspector")).toBeNull();
  });

  it("jumps to birth and just before death, pausing playback", () => {
    const onTimeChange = vi.fn();
    const onPlayingChange = vi.fn();
    render(<MapReplayer playback={marineGame()} time={50} onTimeChange={onTimeChange} onPlayingChange={onPlayingChange} />);
    act(() => frame(16));
    fireEvent.click(screen.getByLabelText(/Map playback of/), MARINE_AT);
    fireEvent.click(screen.getByRole("button", { name: "Jump to birth at 0:10" }));
    expect(onTimeChange).toHaveBeenLastCalledWith(10);
    expect(onPlayingChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Jump to death at 3:20" }));
    expect(onTimeChange).toHaveBeenLastCalledWith(199);
  });

  it("leaves taps to a host that places pins, and closes on a tap on empty ground", () => {
    const onWorldClick = vi.fn();
    const view = render(<MapReplayer playback={marineGame()} time={50} onWorldClick={onWorldClick} />);
    act(() => frame(16));
    fireEvent.click(screen.getByLabelText(/Map playback of/), MARINE_AT);
    expect(onWorldClick).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("replay-unit-inspector")).toBeNull();
    view.rerender(<MapReplayer playback={marineGame()} time={50} />);
    act(() => frame(32));
    fireEvent.click(screen.getByLabelText(/Map playback of/), MARINE_AT);
    expect(screen.getByTestId("replay-unit-inspector")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Map playback of/), { clientX: 200, clientY: 30 });
    expect(screen.queryByTestId("replay-unit-inspector")).toBeNull();
  });

  it("labels single-side vision as approximate", () => {
    render(<MapReplayer playback={marineGame()} time={50} vision="opp" sideLabels={{ opp: "Rival" }} />);
    expect(screen.getByTestId("replay-vision-badge").textContent).toBe("Vision: Rival · approximate vision");
  });
});
