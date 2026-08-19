import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MapReplayer } from "../../MapReplayer";
import { ReplayStage } from "../ReplayStage";
import { payload } from "./fixtures";

// vitest.config.ts sets globals:false, so React Testing Library never
// registers its automatic cleanup -- without this every render stays
// mounted and the next query matches the previous test's DOM too.
afterEach(() => cleanup());

/**
 * The ⤢ control. It used to reset the zoom, which is not what the icon
 * says and not what the user expected; it now toggles real fullscreen
 * on the STAGE (so the HUD rails come with it), and the reset moved to
 * its own ⟲ button.
 *
 * jsdom implements neither the Fullscreen API nor the element sizing it
 * changes, so the API surface is stubbed here. What these tests can
 * prove: which element is asked to go fullscreen, that the button
 * reflects the DOCUMENT's state rather than its own clicks, that Esc
 * (a bare ``fullscreenchange``) is honoured, and that the control hides
 * itself when the API is absent.
 */

type FsDoc = Document & {
  fullscreenEnabled: boolean;
  fullscreenElement: Element | null;
  exitFullscreen: () => Promise<void>;
};

const original = {
  enabled: Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenEnabled"),
  element: Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement"),
};

/** Install a minimal, synchronous Fullscreen API on jsdom. */
function installFullscreenApi(): {
  requested: Element[];
  exits: number;
  enter: (el: Element) => void;
  exit: () => void;
} {
  const state = { requested: [] as Element[], exits: 0, current: null as Element | null };
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => state.current,
  });
  (document as FsDoc).exitFullscreen = () => {
    state.exits += 1;
    return Promise.resolve();
  };
  Element.prototype.requestFullscreen = function requestFullscreen(this: Element) {
    state.requested.push(this);
    return Promise.resolve();
  };
  // ``act`` because the listener sets React state: a bare dispatch
  // leaves the re-render queued and every assertion reads stale DOM.
  const fire = () => act(() => {
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  return {
    get requested() {
      return state.requested;
    },
    get exits() {
      return state.exits;
    },
    enter: (el: Element) => {
      state.current = el;
      fire();
    },
    exit: () => {
      state.current = null;
      fire();
    },
  };
}

function removeFullscreenApi(): void {
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    get: () => false,
  });
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => null,
  });
  // @ts-expect-error deliberately removing the API to test detection
  delete Element.prototype.requestFullscreen;
  // @ts-expect-error deliberately removing the API to test detection
  delete document.exitFullscreen;
}

afterEach(() => {
  // @ts-expect-error restoring jsdom's own (absent) descriptors
  delete Element.prototype.requestFullscreen;
  // @ts-expect-error restoring jsdom's own (absent) descriptors
  delete document.exitFullscreen;
  if (original.enabled) {
    Object.defineProperty(Document.prototype, "fullscreenEnabled", original.enabled);
  }
  if (original.element) {
    Object.defineProperty(Document.prototype, "fullscreenElement", original.element);
  }
  // @ts-expect-error the stubs were own properties on the instance
  delete document.fullscreenEnabled;
  // @ts-expect-error the stubs were own properties on the instance
  delete document.fullscreenElement;
});

describe("the replayer's view controls", () => {
  let api: ReturnType<typeof installFullscreenApi>;
  beforeEach(() => {
    api = installFullscreenApi();
  });

  it("offers a labelled fullscreen toggle AND a separate reset-zoom button", () => {
    render(<MapReplayer playback={payload()} />);
    const fs = screen.getByTestId("replay-fullscreen");
    const reset = screen.getByTestId("replay-reset-zoom");
    expect(fs.getAttribute("aria-label")).toBe("Full screen");
    expect(fs.getAttribute("aria-pressed")).toBe("false");
    expect(reset.getAttribute("aria-label")).toBe("Reset zoom");
    // Both are real buttons, so both are in the tab order.
    expect(fs.tagName).toBe("BUTTON");
    expect(reset.tagName).toBe("BUTTON");
    expect(fs.getAttribute("type")).toBe("button");
    expect(reset.getAttribute("type")).toBe("button");
    // The reset control no longer wears the fullscreen glyph.
    expect(reset.textContent).toBe("⟲");
    expect(fs.textContent).toBe("⤢");
  });

  it("requests fullscreen on the replayer's own root when there is no stage", () => {
    render(<MapReplayer playback={payload()} />);
    fireEvent.click(screen.getByTestId("replay-fullscreen"));
    expect(api.requested).toHaveLength(1);
    expect(api.requested[0]).toBe(screen.getByTestId("map-replayer"));
  });

  it("requests fullscreen on the STAGE when one wraps it, so the rails come too", () => {
    render(<ReplayStage playback={payload()} />);
    fireEvent.click(screen.getByTestId("replay-fullscreen"));
    expect(api.requested).toHaveLength(1);
    expect(api.requested[0]).toBe(screen.getByTestId("replay-stage"));
    // …and that element really does contain the rails.
    expect(
      (api.requested[0] as HTMLElement).contains(
        screen.getByTestId("replay-production-rail"),
      ),
    ).toBe(true);
  });

  it("reflects the DOCUMENT's state, not its own click", () => {
    render(<MapReplayer playback={payload()} />);
    const btn = screen.getByTestId("replay-fullscreen");
    fireEvent.click(btn);
    // The request resolved but no fullscreenchange fired yet: still off.
    expect(
      screen.getByTestId("replay-fullscreen").getAttribute("aria-pressed"),
    ).toBe("false");
    api.enter(screen.getByTestId("map-replayer"));
    const on = screen.getByTestId("replay-fullscreen");
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.getAttribute("aria-label")).toBe("Exit full screen");
    expect(on.textContent).toBe("⤡");
  });

  it("follows an Esc exit, which fires no click at all", () => {
    render(<MapReplayer playback={payload()} />);
    api.enter(screen.getByTestId("map-replayer"));
    expect(
      screen.getByTestId("replay-fullscreen").getAttribute("aria-pressed"),
    ).toBe("true");
    api.exit();
    const off = screen.getByTestId("replay-fullscreen");
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(off.getAttribute("aria-label")).toBe("Full screen");
  });

  it("exits through the API when clicked while fullscreen", () => {
    render(<MapReplayer playback={payload()} />);
    api.enter(screen.getByTestId("map-replayer"));
    fireEvent.click(screen.getByTestId("replay-fullscreen"));
    expect(api.exits).toBe(1);
    expect(api.requested).toHaveLength(0);
  });

  it("ignores a fullscreen element that is not ours", () => {
    render(<MapReplayer playback={payload()} />);
    const stranger = document.createElement("div");
    document.body.appendChild(stranger);
    api.enter(stranger);
    expect(
      screen.getByTestId("replay-fullscreen").getAttribute("aria-pressed"),
    ).toBe("false");
    stranger.remove();
  });

  it("re-measures the canvas when fullscreen flips, so it is never left stale", () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    render(<MapReplayer playback={payload()} />);
    const before = spy.mock.calls.length;
    api.enter(screen.getByTestId("map-replayer"));
    // The sizing pass re-runs (it ends by re-setting the 2D transform),
    // which is what stops the canvas keeping its pre-fullscreen size.
    expect(spy.mock.calls.length).toBeGreaterThan(before);
    spy.mockRestore();
  });
});

describe("without the Fullscreen API", () => {
  beforeEach(() => {
    removeFullscreenApi();
  });

  it("hides the control entirely rather than offering a dead button", () => {
    render(<MapReplayer playback={payload()} />);
    expect(screen.queryByTestId("replay-fullscreen")).toBeFalsy();
    // The reset control is unaffected — it never needed the API.
    expect(screen.getByTestId("replay-reset-zoom")).toBeTruthy();
  });
});
