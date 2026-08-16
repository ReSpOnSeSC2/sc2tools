/**
 * OverlaySceneClient — the ``?demo=1`` contract.
 *
 * Demo mode is what the Settings preview and the offline render script
 * both load, and it has one rule that is easy to break by accident:
 * nothing in it may be derived from ``Date.now()`` during render.
 * Doing so feeds the countdown effect a new deadline every render, so
 * it re-arms its interval and calls setState on each pass — a loop
 * that pins a CPU and is one slow frame away from React's "Maximum
 * update depth exceeded".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const socket = vi.hoisted(() => ({
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  close: vi.fn(),
}));
const io = vi.hoisted(() =>
  vi.fn((_url: string, _opts: { auth: { overlayToken: string } }) => socket),
);
vi.mock("socket.io-client", () => ({ io }));

import { OverlaySceneClient } from "../OverlaySceneClient";
import {
  STREAM_BACKGROUND_IDS,
  getStreamBackground,
} from "@/lib/streamBackgrounds";

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("demo mode", () => {
  it("arms no timers at all", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<OverlaySceneClient token="tok" scene="intermission" demo />);
    // No countdown tick, and no studio poll: both would be pure churn
    // in a preview showing sample values.
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("does not re-arm a timer as time passes", () => {
    // The regression: a Date.now()-derived deadline recomputed on
    // every render made this grow without bound.
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      render(<OverlaySceneClient token="tok" scene="brb" demo />);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(setIntervalSpy).not.toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a stable sample countdown rather than a running clock", () => {
    // scripts/render-scene.mjs exports a seamless loop through this
    // same flag — a ticking clock would differ between frame 0 and
    // frame N and jump at the seam.
    vi.useFakeTimers();
    try {
      render(<OverlaySceneClient token="tok" scene="starting-soon" demo />);
      expect(screen.getByText("05:00")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByText("05:00")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens no socket and polls no studio state", () => {
    render(<OverlaySceneClient token="tok" scene="intermission" demo />);
    expect(io).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders the scene named in the URL", () => {
    const { container } = render(
      <OverlaySceneClient token="tok" scene="intermission" demo />,
    );
    expect(
      container.querySelector(".sc2bd")?.getAttribute("data-variant"),
    ).toBe("intermission");
    expect(screen.getByText("INTERMISSION")).toBeTruthy();
  });

  it("previews the otherwise-transparent manual cover as Starting Soon", () => {
    render(<OverlaySceneClient token="tok" scene="manual" demo />);
    expect(screen.getByText("STARTING SOON")).toBeTruthy();
  });
});

describe("live mode", () => {
  it("opens the overlay socket with the token as auth", () => {
    render(<OverlaySceneClient token="tok" scene="between-games" />);
    expect(io).toHaveBeenCalledTimes(1);
    expect(io.mock.calls[0]?.[1].auth.overlayToken).toBe("tok");
  });

  it("shows no countdown until the dock sets one", () => {
    render(<OverlaySceneClient token="tok" scene="brb" />);
    expect(screen.getByText("BE RIGHT BACK")).toBeTruthy();
    expect(screen.queryByText(/^\d\d:\d\d$/)).toBeNull();
  });

  it("keeps the manual cover fully transparent while the dock is Live", () => {
    const { container } = render(
      <OverlaySceneClient token="tok" scene="manual" />,
    );
    expect(container.querySelector(".sc2bd")).toBeNull();
    expect(
      container.querySelector('[data-variant="manual-inactive"]'),
    ).toBeTruthy();
  });

  it.each([
    ["starting", "STARTING SOON"],
    ["brb", "BE RIGHT BACK"],
  ] as const)(
    "makes the manual cover opaque when the dock selects %s",
    async (mode, headline) => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          scene: {
            mode,
            message: "Manual break",
            countdownEndsAt: null,
            setAtMs: Date.now(),
          },
          updatedAt: new Date().toISOString(),
        }),
      });

      const { container } = render(
        <OverlaySceneClient token="tok" scene="manual" />,
      );

      expect(await screen.findByText(headline)).toBeTruthy();
      expect(screen.getByText("Manual break")).toBeTruthy();
      expect(container.querySelector(".sc2bd")).toBeTruthy();
      expect(
        container.querySelector('[data-variant="manual-inactive"]'),
      ).toBeNull();
    },
  );
});

describe("independent virtual-set scenes", () => {
  it.each(STREAM_BACKGROUND_IDS)(
    "renders %s from its stable catalog asset",
    (backgroundId) => {
      const background = getStreamBackground(backgroundId);
      const { container } = render(
        <OverlaySceneClient token="tok" scene={backgroundId} />,
      );
      expect(
        container.querySelector('[data-scene-kind="cinematic-background"]')
          ?.getAttribute("data-background-id"),
      ).toBe(backgroundId);
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        background.src1080,
      );
      expect(container.querySelector(".sc2bd")).toBeNull();
    },
  );

  it("opens no socket and starts no studio polling", () => {
    render(
      <OverlaySceneClient
        token="tok"
        scene="interstellar-broadcast-studio"
      />,
    );
    expect(io).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
