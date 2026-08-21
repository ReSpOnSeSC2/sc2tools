import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MapReplayer } from "../../MapReplayer";
import { ReplayStage } from "../ReplayStage";
import { REPLAY_SCOPE_CLASS } from "../replayTheme";
import { payload } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Regression cover for the two bugs that made the replay unusable:
 * a map pinned at its 240 px floor, and a stage that painted itself
 * near-black while its panels used the PAGE's colour tokens.
 *
 * jsdom does no layout, so every box measures 0×0 — which is exactly
 * the state the old sizing pass mistook for "there is no room". The
 * tests below stub ``getBoundingClientRect`` to hand the replayer a
 * real container and assert it uses it, and assert the structural
 * invariants (an out-of-flow canvas, a full-width root, a definite
 * middle band) that stop the circular measurement coming back.
 */

/** Every element reports this box; only the replayer's wrapper is read. */
function stubLayout(width: number, height: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

describe("replay stage sizing", () => {
  it("sizes the canvas to the container the stage gives it, not to a floor", () => {
    // 900 × 620 of room, and the fixture map is square: the canvas
    // should take the full 620 px of height. Before the fix it took
    // 240 — the ``Math.max(240, 0)`` floor — because the box it
    // measured was sized by the canvas it was about to size.
    stubLayout(900, 620);
    render(<ReplayStage playback={payload()} />);
    const canvas = screen.getByTestId("map-replayer").querySelector("canvas");
    expect(canvas?.style.width).toBe("620px");
    expect(canvas?.style.height).toBe("620px");
  });

  it("keeps the map at the MAP's aspect, narrowing rather than letterboxing", () => {
    // A 2:1 landscape map in a square-ish box: width is the binding
    // constraint, so the canvas is 900 × 450 and no pixel is padding.
    stubLayout(900, 620);
    render(
      <ReplayStage
        playback={payload({ bounds: { minX: 0, minY: 0, maxX: 200, maxY: 100 } })}
      />,
    );
    const canvas = screen.getByTestId("map-replayer").querySelector("canvas");
    expect(canvas?.style.width).toBe("900px");
    expect(canvas?.style.height).toBe("450px");
  });

  it("takes the canvas OUT OF FLOW so it cannot size the box it is measured against", () => {
    stubLayout(900, 620);
    render(<ReplayStage playback={payload()} />);
    const root = screen.getByTestId("map-replayer");
    const canvas = root.querySelector("canvas");
    const frame = canvas?.parentElement;
    expect(frame?.className).toContain("absolute");
    // …and the box that IS measured takes its size from the host.
    const wrap = frame?.parentElement;
    expect(wrap?.className).toContain("flex-1");
    expect(wrap?.className).toContain("min-h-0");
    // A flex item defaults to shrink-to-fit; without this the root
    // would size itself to the canvas.
    expect(root.className).toContain("w-full");
  });

  it("still honours a host's maxHeightPx when it is NOT filling a container", () => {
    // The compact drilldown path: no ``fill``, so the height cap wins
    // over the (stubbed, definite) container height.
    stubLayout(900, 620);
    render(<MapReplayer playback={payload()} maxHeightPx={420} />);
    const canvas = screen.getByTestId("map-replayer").querySelector("canvas");
    expect(canvas?.style.width).toBe("420px");
  });

  it("lays the stage out as a player: fixed bar, flexible middle, fixed dock", () => {
    render(<ReplayStage playback={payload()} />);
    const stage = screen.getByTestId("replay-stage");
    expect(stage.className).toContain("flex-col");
    // The definite height at xl is what gives the middle band — and so
    // the canvas — a box that is not derived from its own content.
    expect(stage.className).toMatch(/xl:h-\[min\(88vh,1040px\)\]/);
    expect(screen.getByTestId("replay-top-bar").className).toContain("shrink-0");
    expect(screen.getByTestId("replay-transport").className).toContain("shrink-0");
  });
});

describe("replay stage colour scope", () => {
  it("carries its own token scope, so it does not inherit the page's theme", () => {
    render(<ReplayStage playback={payload()} />);
    // The stage paints STAGE_BG in BOTH themes; without this class the
    // panels inside resolve ``text-text`` etc. against the PAGE's
    // ground, which is near-black ink on a near-black stage in light.
    expect(screen.getByTestId("replay-stage").className).toContain(
      REPLAY_SCOPE_CLASS,
    );
  });

  it("scopes a bare replayer too, but only when IT paints the stage ground", () => {
    render(<MapReplayer playback={payload()} />);
    // Not fullscreen: no stage background is painted, so the replayer
    // must NOT force a dark scope onto a light-theme card.
    expect(screen.getByTestId("map-replayer").className).not.toContain(
      REPLAY_SCOPE_CLASS,
    );
  });
});
