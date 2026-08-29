import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrollPlayer, type BrollClip } from "../BrollPlayer";
import {
  createBrollPlaybackOrder,
  effectiveBrollPlayback,
  resolveBrollTimeline,
} from "../brollTimeline";

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

const SHUFFLE_CLIPS: BrollClip[] = [
  ...CLIPS,
  {
    id: "burrowed-ambush",
    title: "Burrowed ambush catches the army",
    videoId: "QweRTY67890",
    startSeconds: 420,
    endSeconds: 455,
  },
];

const ANCHOR = {
  epochMs: 1_000_000,
  revision: 7,
  seed: 0x1234abcd,
  cursor: 0,
};

const PAIRED_CLIP: BrollClip = {
  ...CLIPS[0],
  vertical: {
    videoId: "vertABC1234",
    startSeconds: 200,
  },
};

interface MockPlayer {
  destroy: ReturnType<typeof vi.fn>;
  getCurrentTime: ReturnType<typeof vi.fn>;
  loadVideoById: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  playVideo: ReturnType<typeof vi.fn>;
  seekTo: ReturnType<typeof vi.fn>;
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
  const players: MockPlayer[] = [];
  const handlerSets: MockHandlers[] = [];
  const Player = vi.fn(function (
    this: unknown,
    _element: HTMLElement,
    options: { events: MockHandlers },
  ) {
    const player: MockPlayer = {
      destroy: vi.fn(),
      getCurrentTime: vi.fn(() => 0),
      loadVideoById: vi.fn(),
      mute: vi.fn(),
      playVideo: vi.fn(),
      seekTo: vi.fn(),
      setVolume: vi.fn(),
      stopVideo: vi.fn(),
      unMute: vi.fn(),
    };
    players.push(player);
    handlerSets.push(options.events);
    queueMicrotask(() => options.events.onReady({ target: player }));
    return player;
  });
  (window as unknown as { YT: unknown }).YT = {
    Player,
    PlayerState: { ENDED: 0, PLAYING: 1 },
  };
  return {
    players,
    get player() {
      const player = players[0];
      if (!player) throw new Error("YouTube player was not constructed");
      return player;
    },
    handlers: () => {
      const handlers = handlerSets[0];
      if (!handlers) throw new Error("YouTube player was not constructed");
      return handlers;
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

describe("BrollPlayer", () => {
  it("renders a generated camera-safe set when no valid clips exist", () => {
    const { container } = render(
      <BrollPlayer
        audioOwner
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

  it("keeps two video players synchronized but gives audio to only one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 5_000);
    const youtube = installYouTubeMock();
    render(
      <>
        <BrollPlayer
          audioOwner
          clips={SHUFFLE_CLIPS}
          shuffle
          muted={false}
          volume={23}
          skipNonce={0}
          playback={ANCHOR}
        />
        <BrollPlayer
          audioOwner={false}
          clips={SHUFFLE_CLIPS}
          shuffle
          muted={false}
          volume={23}
          skipNonce={0}
          playback={ANCHOR}
        />
      </>,
    );
    await act(async () => Promise.resolve());

    expect(youtube.players).toHaveLength(2);
    expect(youtube.players[0].loadVideoById.mock.calls[0][0]).toEqual(
      youtube.players[1].loadVideoById.mock.calls[0][0],
    );
    expect(youtube.players[0].setVolume).toHaveBeenCalledWith(23);
    expect(youtube.players[0].unMute).toHaveBeenCalled();
    expect(youtube.players[1].setVolume).toHaveBeenCalledWith(0);
    expect(youtube.players[1].mute).toHaveBeenCalled();
    expect(youtube.players[1].unMute).not.toHaveBeenCalled();
  });

  it("loads paired horizontal and vertical simulcasts at one shared offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 5_000);
    const youtube = installYouTubeMock();
    render(
      <>
        <BrollPlayer
          audioOwner
          videoFormat="horizontal"
          clips={[PAIRED_CLIP]}
          shuffle={false}
          muted={false}
          volume={23}
          skipNonce={0}
          playback={ANCHOR}
        />
        <BrollPlayer
          audioOwner={false}
          videoFormat="vertical"
          clips={[PAIRED_CLIP]}
          shuffle={false}
          muted={false}
          volume={23}
          skipNonce={0}
          playback={ANCHOR}
        />
      </>,
    );
    await act(async () => Promise.resolve());

    expect(youtube.players[0].loadVideoById).toHaveBeenLastCalledWith({
      videoId: "abcDEF12345",
      startSeconds: 95,
      endSeconds: 120,
    });
    expect(youtube.players[1].loadVideoById).toHaveBeenLastCalledWith({
      videoId: "vertABC1234",
      startSeconds: 205,
      endSeconds: 230,
    });
    const players = screen.getAllByTestId("broll-player");
    expect(players[0].dataset.clipId).toBe(players[1].dataset.clipId);
    expect(players[0].dataset.videoFormat).toBe("horizontal");
    expect(players[1].dataset.videoFormat).toBe("vertical");
    const media = screen.getAllByTestId("broll-media");
    expect(media[0].dataset.videoFit).toBe("cover");
    expect(media[1].dataset.videoFit).toBe("cover");
  });

  it("falls back to the horizontal source when a clip has no vertical pair", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 1_000);
    const youtube = installYouTubeMock();
    render(
      <BrollPlayer
        audioOwner={false}
        videoFormat="vertical"
        clips={[CLIPS[0]]}
        shuffle={false}
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());

    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "abcDEF12345",
      startSeconds: 91,
      endSeconds: 120,
    });
    const media = screen.getByTestId("broll-media");
    expect(media.dataset.videoFit).toBe("contain");
    expect(media.style.width).toBe("100vw");
    expect(media.style.height).toBe("56.25vw");
    expect(media.style.minWidth).toBe("0px");
    expect(media.style.minHeight).toBe("0px");
    act(() => {
      youtube.handlers().onStateChange({ target: youtube.player, data: 1 });
    });
    expect(screen.queryByText("LOADING HIGHLIGHT REEL")).toBeNull();
  });

  it("hides media while an orientation change reloads at the shared offset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 5_000);
    const youtube = installYouTubeMock();
    const view = render(
      <BrollPlayer
        audioOwner
        videoFormat="horizontal"
        clips={[PAIRED_CLIP]}
        shuffle={false}
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    act(() => {
      youtube.handlers().onStateChange({ target: youtube.player, data: 1 });
    });
    expect(screen.getByTestId("broll-media").style.opacity).toBe("1");

    view.rerender(
      <BrollPlayer
        audioOwner
        videoFormat="vertical"
        clips={[PAIRED_CLIP]}
        shuffle={false}
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    expect(screen.getByTestId("broll-media").style.opacity).toBe("0");
    await act(async () => Promise.resolve());

    expect(youtube.players).toHaveLength(2);
    expect(youtube.players[0].destroy).toHaveBeenCalled();
    expect(youtube.players[1].loadVideoById).toHaveBeenLastCalledWith({
      videoId: "vertABC1234",
      startSeconds: 205,
      endSeconds: 230,
    });
  });

  it("loads at the authoritative offset, advances by wall clock, and applies skip/audio updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 5_000);
    const youtube = installYouTubeMock();
    const view = render(
      <BrollPlayer
        audioOwner
        clips={SHUFFLE_CLIPS}
        shuffle={false}
        muted={false}
        volume={23}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "abcDEF12345",
      startSeconds: 95,
      endSeconds: 120,
    });
    expect(youtube.player.setVolume).toHaveBeenCalledWith(23);
    expect(youtube.player.unMute).toHaveBeenCalled();

    // An early iframe event cannot make one OBS copy advance independently.
    act(() => {
      youtube.handlers().onStateChange({ target: youtube.player, data: 0 });
    });
    expect(youtube.player.loadVideoById).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(25_050);
      await Promise.resolve();
    });
    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith(
      expect.objectContaining({ videoId: "ZYXwvu98765", endSeconds: 348 }),
    );

    const skipAnchor = {
      ...ANCHOR,
      epochMs: Date.now(),
      revision: ANCHOR.revision + 1,
      cursor: 2,
    };
    view.rerender(
      <BrollPlayer
        audioOwner
        clips={SHUFFLE_CLIPS}
        shuffle={false}
        muted
        volume={0}
        skipNonce={1}
        playback={skipAnchor}
      />,
    );
    await act(async () => Promise.resolve());
    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "QweRTY67890",
      startSeconds: 420,
      endSeconds: 455,
    });
    expect(youtube.player.setVolume).toHaveBeenLastCalledWith(0);
    expect(youtube.player.mute).toHaveBeenCalled();
  });

  it("retries a rejected clip at the shared offset instead of locally skipping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 1_000);
    const youtube = installYouTubeMock();
    render(
      <BrollPlayer
        audioOwner
        clips={CLIPS}
        shuffle={false}
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "abcDEF12345",
      startSeconds: 91,
      endSeconds: 120,
    });

    act(() => {
      youtube.handlers().onError({ target: youtube.player });
      vi.advanceTimersByTime(3_000);
    });
    expect(youtube.player.loadVideoById).toHaveBeenCalledTimes(2);
    expect(youtube.player.loadVideoById).toHaveBeenLastCalledWith({
      videoId: "abcDEF12345",
      startSeconds: 94,
      endSeconds: 120,
    });
    expect(screen.getByTestId("broll-player").dataset.clipId).toBe(
      "hold-the-line",
    );
  });

  it("uses one deterministic shuffled choice and offset for separate mounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 12_345);
    const firstYouTube = installYouTubeMock();
    const first = render(
      <BrollPlayer
        audioOwner
        clips={SHUFFLE_CLIPS}
        shuffle
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    const firstLoad = firstYouTube.player.loadVideoById.mock.calls[0][0];
    first.unmount();

    // A later independent Browser Source/reconnect gets the same schedule and
    // seeks forward by exactly the wall-clock mount difference.
    vi.setSystemTime(ANCHOR.epochMs + 13_345);
    const secondYouTube = installYouTubeMock();
    render(
      <BrollPlayer
        audioOwner
        clips={SHUFFLE_CLIPS}
        shuffle
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    const secondLoad = secondYouTube.player.loadVideoById.mock.calls[0][0];
    expect(secondLoad.videoId).toBe(firstLoad.videoId);
    expect(secondLoad.startSeconds - firstLoad.startSeconds).toBeCloseTo(1, 5);
  });

  it("seeks a lagging player back to the shared clock as soon as it plays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR.epochMs + 2_000);
    const youtube = installYouTubeMock();
    render(
      <BrollPlayer
        audioOwner
        clips={CLIPS}
        shuffle={false}
        muted
        volume={20}
        skipNonce={0}
        playback={ANCHOR}
      />,
    );
    await act(async () => Promise.resolve());
    youtube.player.getCurrentTime.mockReturnValue(91);

    act(() => {
      youtube.handlers().onStateChange({ target: youtube.player, data: 1 });
    });
    expect(youtube.player.seekTo).toHaveBeenCalledWith(92, true);
  });

  it("builds deterministic complete shuffle cycles and resolves reconnect offsets", () => {
    const first = createBrollPlaybackOrder(8, true, 0xdecafbad);
    const second = createBrollPlaybackOrder(8, true, 0xdecafbad);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(8);
    expect(first).not.toEqual(createBrollPlaybackOrder(8, true, 42));

    const position = resolveBrollTimeline(CLIPS, false, ANCHOR, 1_035_250);
    expect(position).toMatchObject({
      clipIndex: 1,
      cursor: 1,
      offsetMs: 5_250,
      remainingMs: 42_750,
    });
    expect(effectiveBrollPlayback(undefined, 5, SHUFFLE_CLIPS.length)).toEqual({
      epochMs: 0,
      revision: 5,
      seed: 0,
      cursor: 2,
    });
  });
});
