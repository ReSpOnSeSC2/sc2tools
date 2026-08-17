import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  DEFAULT_BROLL_CONFIG,
  sanitizeStudioState,
  useStudioState,
} from "../useStudioState";

function Probe({
  studioEvent,
  token = "tok",
}: {
  studioEvent: unknown;
  token?: string;
}) {
  const studio = useStudioState(token, studioEvent);
  return (
    <>
      <div data-testid="scene-state">
        {studio.loaded ? "loaded" : "loading"}:{studio.scene?.mode ?? "live"}
      </div>
      <div data-testid="snapshot-state">
        {studio.snapshotReady ? "ready" : "unverified"}
      </div>
    </>
  );
}

function sceneState(
  mode: "starting" | "brb" | null,
  updatedAt: string,
) {
  return {
    scene: mode
      ? {
          mode,
          message: mode,
          countdownEndsAt: null,
          setAtMs: Date.parse(updatedAt),
        }
      : null,
    updatedAt,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useStudioState authoritative readiness", () => {
  it("records a failed initial attempt without declaring moderation ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );

    render(<Probe studioEvent={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:live");
    });
    expect(screen.getByTestId("snapshot-state").textContent).toBe(
      "unverified",
    );
  });

  it("accepts an empty successful retry as a known-no-blocklist snapshot", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(<Probe studioEvent={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("snapshot-state").textContent).toBe(
      "unverified",
    );

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("snapshot-state").textContent).toBe("ready");
  });

  it("unlocks from an authoritative socket snapshot after the GET fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const { rerender } = render(<Probe studioEvent={null} />);
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:live");
    });
    expect(screen.getByTestId("snapshot-state").textContent).toBe(
      "unverified",
    );

    rerender(
      <Probe studioEvent={sceneState("brb", "2026-08-04T12:01:00.000Z")} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-state").textContent).toBe("ready");
    });
    expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
  });
});

describe("useStudioState ordering", () => {
  it("does not let an in-flight GET overwrite a newer socket event", async () => {
    let finishFetch: ((value: unknown) => void) | null = null;
    const pendingFetch = new Promise((resolve) => {
      finishFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => pendingFetch));

    const { rerender } = render(<Probe studioEvent={null} />);
    rerender(
      <Probe
        studioEvent={sceneState("brb", "2026-08-04T12:01:00.000Z")}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
    });

    await act(async () => {
      finishFetch?.({
        ok: true,
        json: async () =>
          sceneState("starting", "2026-08-04T12:00:00.000Z"),
      });
      await pendingFetch;
    });

    expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
  });

  it("rejects a delayed older connect replay after a live Dock update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const newer = sceneState("brb", "2026-08-04T12:02:00.000Z");
    const staleReplay = sceneState("starting", "2026-08-04T12:01:00.000Z");

    const { rerender } = render(<Probe studioEvent={newer} />);
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
    });
    rerender(<Probe studioEvent={staleReplay} />);

    expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
  });

  it("rejects an unversioned empty replay after a live Dock update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const newer = sceneState("brb", "2026-08-04T12:02:00.000Z");
    const { rerender } = render(<Probe studioEvent={newer} />);
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
    });

    rerender(<Probe studioEvent={{ scene: null, updatedAt: null }} />);
    expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
  });

  it("accepts a newer Go-live clear after an active manual scene", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const { rerender } = render(
      <Probe
        studioEvent={sceneState("starting", "2026-08-04T12:01:00.000Z")}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe(
        "loaded:starting",
      );
    });

    rerender(
      <Probe studioEvent={sceneState(null, "2026-08-04T12:02:00.000Z")} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:live");
    });
  });

  it("does not carry the ordering watermark across overlay tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    const { rerender } = render(
      <Probe
        token="newer-token"
        studioEvent={sceneState("brb", "2026-08-04T12:02:00.000Z")}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
    });

    rerender(
      <Probe
        token="older-token"
        studioEvent={sceneState("starting", "2026-08-04T12:01:00.000Z")}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe(
        "loaded:starting",
      );
    });
  });

  it("does not replay the previous token's unchanged socket event", async () => {
    const pendingFetches: Array<(value: unknown) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            pendingFetches.push(resolve);
          }),
      ),
    );
    const oldEvent = sceneState("brb", "2026-08-04T12:02:00.000Z");
    const { rerender } = render(
      <Probe token="old-token" studioEvent={oldEvent} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe("loaded:brb");
    });

    rerender(<Probe token="new-token" studioEvent={oldEvent} />);
    await waitFor(() => expect(pendingFetches).toHaveLength(2));
    await act(async () => {
      pendingFetches[1]?.({
        ok: true,
        json: async () =>
          sceneState("starting", "2026-08-04T12:01:00.000Z"),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("scene-state").textContent).toBe(
        "loaded:starting",
      );
    });
  });
});

describe("b-roll state sanitization", () => {
  it("supplies reusable library defaults for legacy studio snapshots", () => {
    expect(sanitizeStudioState({}).broll).toEqual(DEFAULT_BROLL_CONFIG);
  });

  it("keeps only safe ranged YouTube clips and clamps player controls", () => {
    const state = sanitizeStudioState({
      broll: {
        clips: [
          {
            id: "recent-finale",
            title: "  Last stand at the natural  ",
            videoId: "99UKipUcV_s",
            startSeconds: 601.9,
            endSeconds: 674.8,
            iframeHtml: "<iframe />",
          },
          {
            id: "recent-finale",
            title: "Duplicate",
            videoId: "99UKipUcV_s",
            startSeconds: 700,
            endSeconds: 730,
          },
          {
            id: "bad range",
            title: "Invalid",
            videoId: "not-a-video",
            startSeconds: 9,
            endSeconds: 3,
          },
        ],
        shuffle: false,
        muted: true,
        volume: 500,
        skipNonce: 9_999_999_999,
        autoplayScript: "alert(1)",
      },
    });

    expect(state.broll).toEqual({
      clips: [
        {
          id: "recent-finale",
          title: "Last stand at the natural",
          videoId: "99UKipUcV_s",
          startSeconds: 601,
          endSeconds: 674,
        },
      ],
      shuffle: false,
      muted: true,
      volume: 100,
      skipNonce: 2_147_483_647,
    });
    expect(state.broll).not.toHaveProperty("autoplayScript");
    expect(state.broll.clips[0]).not.toHaveProperty("iframeHtml");
  });

  it("accepts only bounded shared playback timeline metadata", () => {
    const state = sanitizeStudioState({
      broll: {
        clips: [
          {
            id: "timeline-clip",
            title: "Timeline clip",
            videoId: "99UKipUcV_s",
            startSeconds: 10,
            endSeconds: 20,
          },
        ],
        playback: {
          epochMs: 123_456.7,
          revision: 8.9,
          seed: -1,
          cursor: 900,
          script: "alert(1)",
        },
      },
    });

    expect(state.broll.playback).toEqual({
      epochMs: 123_457,
      revision: 8,
      seed: 4_294_967_295,
      cursor: 0,
    });
    expect(state.broll.playback).not.toHaveProperty("script");
  });
});
