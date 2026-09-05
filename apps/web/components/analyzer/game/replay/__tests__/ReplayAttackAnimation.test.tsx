import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapReplayer } from "../../MapReplayer";
import { payload } from "./fixtures";

const spriteState = vi.hoisted(() => ({ draw: vi.fn() }));
vi.mock("@/lib/spriteSheets", () => {
  const anim = { frames: 8, fps: 8, cols: 8, rows: 8, suffix: null, wupc: 2, ax: 128, ay: 128 };
  const sprite = { name: "Marine", meta: { kind: "unit", race: "Terran", frameSize: 256, facings: 8,
    anims: { Stand: anim, Walk: anim, Attack: anim } }, handles: {} };
  const handles = Object.fromEntries(["Stand", "Walk", "Attack"].map((name) => [name, { name, anim, sprite }]));
  return { beginSpriteFrame: vi.fn(), endSpriteFrame: vi.fn(), drawSprite: spriteState.draw, hasWalk: () => true,
    resolveSprite: () => sprite, spriteAnim: (_s: unknown, name: string) => handles[name], spriteAssetsVersion: () => 0 };
});

let frame: FrameRequestCallback;
beforeEach(() => {
  spriteState.draw.mockReset().mockReturnValue(true);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const ctx = new Proxy({ createRadialGradient: () => ({ addColorStop: vi.fn() }) }, {
    get(target, key) { return key in target ? target[key as keyof typeof target] : vi.fn(); },
  }) as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("map attack sprite integration", () => {
  it("selects the attack clip, faces its observed target, and rewinds back to Stand", () => {
    const p = payload({ v: 6, buildings: [], resources: [], battles: [],
      fidelity: { positions: "engine", paths: "observed", creep: "observed", attacks: "observed", complete: true },
      units: [{ owner: "me", name: "Marine",
      born: 0, died: null, wp: [0, 30, 30, 20, 30, 30], attacks: [10], aim: [10, 40, 30] }] });
    const view = render(<MapReplayer playback={p} time={10.5} />);
    act(() => frame(100));
    const first = spriteState.draw.mock.calls[0];
    expect(first[1].name).toBe("Attack");
    expect(first[3]).toBe(2); // east toward the recorded target
    expect(first[4]).toBe(4);
    spriteState.draw.mockClear();
    view.rerender(<MapReplayer playback={p} time={9} />);
    act(() => frame(120));
    expect(spriteState.draw.mock.calls[0][1].name).toBe("Stand");
    expect(spriteState.draw.mock.calls[0][3]).toBe(0);
  });

  it("keeps the loaded idle model while a first attack clip is decoding", () => {
    spriteState.draw.mockImplementation((_ctx, handle) => handle.name !== "Attack");
    const p = payload({ v: 6, buildings: [], resources: [], battles: [],
      fidelity: { positions: "engine", paths: "observed", creep: "observed", attacks: "observed", complete: true },
      units: [{ owner: "me", name: "Marine", born: 0, died: null, wp: [0, 30, 30], attacks: [10] }] });
    render(<MapReplayer playback={p} time={10.5} />);
    act(() => frame(100));
    expect(spriteState.draw.mock.calls.map((c) => c[1].name)).toEqual(["Attack", "Stand"]);
    expect(spriteState.draw.mock.calls[1].slice(5, 7)).toEqual(spriteState.draw.mock.calls[0].slice(5, 7));
  });

  it("does not invent attack cycles from battle markers", () => {
    const p = payload({ buildings: [], resources: [], battles: [{t: 10, x: 30, y: 30}], units: [{ owner: "me", name: "Marine",
      born: 0, died: null, wp: [0, 30, 30, 20, 30, 30] }] });
    render(<MapReplayer playback={p} time={10.5} />);
    act(() => frame(100));
    expect(spriteState.draw.mock.calls[0][1].name).toBe("Stand");
  });
});
