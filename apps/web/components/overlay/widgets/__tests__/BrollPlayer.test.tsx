import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrollPlayer,
  createBrollShuffleBag,
  type BrollClip,
} from "../BrollPlayer";

const CLIPS: BrollClip[] = [
  {
    id: "hold-the-line",
    title: "Holding the line with six marines",
    videoId: "abcDEF12345",
    startSeconds: 90,
    endSeconds: 120,
  },
  {
    id: "carrier-finish",
    title: "Carrier fleet closes it out",
    videoId: "ZYXwvu98765",
    startSeconds: 300,
    endSeconds: 348,
  },
];

interface MockPlayer {
  destroy: ReturnType<typeof vi.fn>;
  loadVideoById: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  playVideo: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
  stopVideo: ReturnType<typeof vi.fn>;
  unMute: ReturnType<typeof vi.fn>;
}

interface MockHandlers {
  onReady(event: { target: MockPlayer }): void;
  onStateChange(event: { target: MockPlayer; data: number }): void;
  onError(event: { target: MockPlayer }): void;
}

function installYouTubeMock() {
  const player: MockPlayer = {
    destroy: vi.fn(),
    loadVideoById: vi.fn(),
    mute: vi.fn(),
    playVideo: vi.fn(),
    setVolume: vi.fn(),
    stopVideo: vi.fn(),
    unMute: vi.fn(),
  };
  let handlers: MockHandlers | null = null;
  const Player = vi.fn(function (
    this: unknown,
    _element: HTMLElement,
    options: { events: MockHandlers },
  ) {
    handlers = options.events;
    queueMicrotask(() => options.events.onReady({ target: player }));
    return player;
  });
  (window as unknown as { YT: unknown }).YT = {
    Player,
    PlayerState: { ENDED: 0, PLAYING: 1 },
  };
  return {
    player,
    handlers: () => {
      if (!handlers) throw new Error("YouTube player was not constructed");
      return handlers;
    },
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { YT?: unknown }).YT;
});

describe("BrollPlayer", () => {
  it("renders a generated camera-safe set when no valid clips exist", () => {
    const { container } = render(
      <BrollPlayer
        clips={[]}
        shuffle
        muted={false}
        volume={20}
        skipNonce={0}
      />,
    );

    expect(screen.getByTestId("broll-player").dataset.playbackStatus).toBe(
      "empty",
    );
    expect(screen.getByText("HIGHLIGHT REEL READY")).toBeTruthy();
    expect(screen.queryByTestId("broll-media")).toBeNull();
    expect(screen.getByTestId("broll-set-fallback")).toBeTruthy();
    expect(container.querySelector(".broll-set-current img")?.getAttribute("src"))
      .toBe("/stream-backgrounds/1080p/01-frontier-cantina.jpg");
    expect(container.querySelectorAll(".broll-set-layer")).toHaveLength(1);
  });

  it("loads time ranges, applies audio, auto-advances, and reacts to skipNonce", async () => {
    const youtube = installYouTubeMock();
    const view = render(
      <BrollPlayer
        clips={CLIPS}
        shuffle={false}
        muted={false}
        volume={23}
        skipNonce={0}
      />,
    );

    await waitFor(() => {
      expect(youtube.player.loadVideoById).toHaveBeenCalledWith({
        videoId: "abcDEF12345",
        startSeconds: 90,
        endSeconds: 120,
      });
    });
    expect(youtube.player.setVolume).toHaveBeenCalledWith(23);
    expect(youtube.player.unMute).toHaveBeenCalled();

    act(() => {
      youtube.handlers().onStateChange({
        target: youtube.player,
        data: 1,
      });
    });
    expect(screen.getByTestId("broll-player").dataset.playbackStatus).toBe(
      "playing",
    );

    act(() => {
      youtube.handlers().onStateChange({
        target: youtube.player,
        data: 0,
      });
    });
    await waitFor(() => {
      expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
        videoId: "ZYXwvu98765",
        startSeconds: 300,
        endSeconds: 348,
      });
    });

    view.rerender(
      <BrollPlayer
        clips={CLIPS}
        shuffle={false}
        muted
        volume={0}
        skipNonce={1}
      />,
    );
    await waitFor(() => {
      expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
        videoId: "abcDEF12345",
        startSeconds: 90,
        endSeconds: 120,
      });
    });
    expect(youtube.player.setVolume).toHaveBeenLastCalledWith(0);
    expect(youtube.player.mute).toHaveBeenCalled();
  });

  it("falls back without a blank canvas when every clip is rejected", async () => {
    const youtube = installYouTubeMock();
    render(
      <BrollPlayer
        clips={[CLIPS[0]]}
        shuffle
        muted
        volume={20}
        skipNonce={0}
      />,
    );
    await waitFor(() => {
      expect(youtube.player.loadVideoById).toHaveBeenCalled();
    });

    act(() => {
      youtube.handlers().onError({ target: youtube.player });
    });
    expect(screen.getByTestId("broll-player").dataset.playbackStatus).toBe(
      "fallback",
    );
    expect(screen.getByText("HIGHLIGHT REEL STANDBY")).toBeTruthy();
    expect(youtube.player.stopVideo).toHaveBeenCalled();
  });

  it("builds complete shuffle cycles without replaying the current clip", () => {
    const samples = [0.73, 0.12, 0.91, 0.44];
    let sample = 0;
    const bag = createBrollShuffleBag(5, 2, () => samples[sample++] ?? 0);

    expect(bag).toHaveLength(4);
    expect(new Set(bag).size).toBe(4);
    expect(bag).not.toContain(2);
    expect([...bag].sort()).toEqual([0, 1, 3, 4]);
  });
});
