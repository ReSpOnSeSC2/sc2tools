"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  StudioBrollClip,
  StudioBrollConfig,
} from "@/lib/multichat/useStudioState";
import { STREAM_BACKGROUNDS } from "@/lib/streamBackgrounds";

const YOUTUBE_IFRAME_API = "https://www.youtube.com/iframe_api";
const API_READY_TIMEOUT_MS = 12_000;
const PLAYBACK_WATCHDOG_GRACE_MS = 8_000;
const FAILED_CYCLE_RETRY_MS = 3_000;
const BACKGROUND_ROTATE_MS = 24_000;

export type BrollClip = StudioBrollClip;
export type BrollPlayerConfig = StudioBrollConfig;

export interface BrollPlayerProps extends StudioBrollConfig {
  /** Optional wording for the broadcast-safe canvas shown without video. */
  fallbackLabel?: string;
}

type PlaybackStatus = "empty" | "loading" | "playing" | "fallback";

interface YouTubePlayer {
  destroy(): void;
  loadVideoById(options: {
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }): void;
  mute(): void;
  playVideo(): void;
  setVolume(volume: number): void;
  stopVideo(): void;
  unMute(): void;
}

interface YouTubeEvent {
  target: YouTubePlayer;
}

interface YouTubeStateEvent extends YouTubeEvent {
  data: number;
}

interface YouTubeApi {
  Player: new (
    element: HTMLElement,
    options: {
      width: string;
      height: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady(event: YouTubeEvent): void;
        onStateChange(event: YouTubeStateEvent): void;
        onError(event: YouTubeEvent): void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
  };
}

type YouTubeWindow = Window &
  typeof globalThis & {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  };

let youtubeApiPromise: Promise<YouTubeApi> | null = null;

/**
 * A shuffled cycle containing every clip except the one already on screen.
 * The exclusion also prevents a repeat at the seam between two cycles.
 */
export function createBrollShuffleBag(
  clipCount: number,
  currentIndex: number,
  random: () => number = Math.random,
): number[] {
  const count = Math.max(0, Math.floor(clipCount));
  if (count <= 1) return count === 1 ? [0] : [];

  const bag = Array.from({ length: count }, (_, index) => index).filter(
    (index) => index !== currentIndex,
  );
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const sample = random();
    const bounded = Number.isFinite(sample)
      ? Math.min(0.999999, Math.max(0, sample))
      : 0;
    const j = Math.floor(bounded * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

/**
 * Full-canvas YouTube highlight reel for OBS Browser Sources.
 *
 * The component owns playback only. Stream-scene wording and timers remain in
 * StreamSceneWidget so the Dock's existing countdown remains authoritative.
 */
export function BrollPlayer({
  clips,
  shuffle,
  muted,
  volume,
  skipNonce,
  fallbackLabel = "HIGHLIGHT REEL STANDBY",
}: BrollPlayerProps) {
  const playableClips = useMemo(() => normalizeClips(clips), [clips]);
  const signature = useMemo(
    () => playableClips.map(clipKey).join("\u001f"),
    [playableClips],
  );
  const firstIndex =
    shuffle && playableClips.length > 1
      ? Math.floor(Math.random() * playableClips.length)
      : 0;
  const [playback, setPlayback] = useState({ index: firstIndex, generation: 0 });
  const [status, setStatus] = useState<PlaybackStatus>(
    playableClips.length > 0 ? "loading" : "empty",
  );
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);

  const safeVolume = clampVolume(volume);
  const currentClip = playableClips[playback.index] ?? playableClips[0] ?? null;
  const currentKey = currentClip ? clipKey(currentClip) : "";

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);
  const clipsRef = useRef(playableClips);
  const currentClipRef = useRef(currentClip);
  const mutedRef = useRef(muted);
  const volumeRef = useRef(safeVolume);
  const shuffleBagRef = useRef<number[]>(
    shuffle
      ? createBrollShuffleBag(playableClips.length, firstIndex)
      : [],
  );
  const failedClipKeysRef = useRef(new Set<string>());
  const watchdogRef = useRef<number | null>(null);
  const advanceLockedRef = useRef(false);
  const signatureRef = useRef(signature);
  const shuffleRef = useRef(shuffle);
  const previousSkipNonceRef = useRef(skipNonce);

  clipsRef.current = playableClips;
  currentClipRef.current = currentClip;
  mutedRef.current = muted;
  volumeRef.current = safeVolume;

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const advancePlayback = useCallback(() => {
    const count = clipsRef.current.length;
    if (count === 0 || advanceLockedRef.current) return;
    advanceLockedRef.current = true;
    clearWatchdog();
    setPlayback((previous) => {
      const current = Math.min(previous.index, count - 1);
      let next = 0;
      if (count === 1) {
        next = 0;
      } else if (shuffleRef.current) {
        let bag = shuffleBagRef.current.filter(
          (index) => index >= 0 && index < count && index !== current,
        );
        if (bag.length === 0) {
          bag = createBrollShuffleBag(count, current);
        }
        next = bag.shift() ?? ((current + 1) % count);
        shuffleBagRef.current = bag;
      } else {
        next = (current + 1) % count;
      }
      return { index: next, generation: previous.generation + 1 };
    });
  }, [clearWatchdog]);

  const advanceRef = useRef(advancePlayback);
  advanceRef.current = advancePlayback;

  const handleClipFailure = useCallback(
    (clip: BrollClip) => {
      clearWatchdog();
      failedClipKeysRef.current.add(clipKey(clip));
      if (failedClipKeysRef.current.size < clipsRef.current.length) {
        advanceRef.current();
        return;
      }

      // YouTube errors can be transient (especially while multiple OBS browser
      // sources initialize together). A non-empty library must not become a
      // terminal standby screen after one rejected pass. Pause briefly to
      // avoid a hot error loop, then start another cycle.
      setStatus("fallback");
      watchdogRef.current = window.setTimeout(() => {
        watchdogRef.current = null;
        failedClipKeysRef.current.clear();
        advanceRef.current();
      }, FAILED_CYCLE_RETRY_MS);
    },
    [clearWatchdog],
  );

  const applyAudio = useCallback((player: YouTubePlayer) => {
    player.setVolume(volumeRef.current);
    if (mutedRef.current || volumeRef.current === 0) player.mute();
    else player.unMute();
  }, []);

  const loadCurrentClip = useCallback(() => {
    const player = playerRef.current;
    const clip = currentClipRef.current;
    if (!player || !playerReadyRef.current || !clip) return;

    clearWatchdog();
    setStatus("loading");
    try {
      applyAudio(player);
      player.loadVideoById({
        videoId: clip.videoId,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
      });
      player.playVideo();
      const durationMs = (clip.endSeconds - clip.startSeconds) * 1000;
      watchdogRef.current = window.setTimeout(() => {
        advanceRef.current();
      }, durationMs + PLAYBACK_WATCHDOG_GRACE_MS);
    } catch {
      handleClipFailure(clip);
    }
  }, [applyAudio, clearWatchdog, handleClipFailure]);

  const loadCurrentClipRef = useRef(loadCurrentClip);
  loadCurrentClipRef.current = loadCurrentClip;

  // A replacement library starts a fresh reel. Merely changing volume or the
  // skip nonce does not disturb its position.
  useEffect(() => {
    if (signatureRef.current === signature) return;
    signatureRef.current = signature;
    failedClipKeysRef.current.clear();
    clearWatchdog();
    setHasStartedPlayback(false);
    const count = playableClips.length;
    const nextIndex =
      shuffle && count > 1 ? Math.floor(Math.random() * count) : 0;
    shuffleBagRef.current = shuffle
      ? createBrollShuffleBag(count, nextIndex)
      : [];
    setPlayback((previous) => ({
      index: nextIndex,
      generation: previous.generation + 1,
    }));
    if (count === 0) setStatus("empty");
  }, [clearWatchdog, playableClips.length, shuffle, signature]);

  useEffect(() => {
    if (shuffleRef.current === shuffle) return;
    shuffleRef.current = shuffle;
    shuffleBagRef.current = shuffle
      ? createBrollShuffleBag(playableClips.length, playback.index)
      : [];
  }, [playableClips.length, playback.index, shuffle]);

  // Construct one YouTube player per library. Individual clips are loaded into
  // it so auto-advance does not churn iframes or flash the page background.
  const hasPlayableClips = playableClips.length > 0;
  useEffect(() => {
    if (!hasPlayableClips || !mountRef.current) {
      setStatus("empty");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled || !mountRef.current) return;
        const player = new YT.Player(mountRef.current, {
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: 1,
            controls: 0,
            disablekb: 1,
            enablejsapi: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
          },
          events: {
            onReady(event) {
              if (cancelled) return;
              playerRef.current = event.target;
              playerReadyRef.current = true;
              applyAudio(event.target);
              loadCurrentClipRef.current();
            },
            onStateChange(event) {
              if (cancelled) return;
              if (event.data === YT.PlayerState.PLAYING) {
                failedClipKeysRef.current.clear();
                setHasStartedPlayback(true);
                setStatus("playing");
              } else if (event.data === YT.PlayerState.ENDED) {
                advanceRef.current();
              }
            },
            onError() {
              if (cancelled) return;
              const clip = currentClipRef.current;
              if (!clip) {
                setStatus("fallback");
                return;
              }
              handleClipFailure(clip);
            },
          },
        });
        playerRef.current = player;
      })
      .catch(() => {
        if (!cancelled) setStatus("fallback");
      });

    return () => {
      cancelled = true;
      clearWatchdog();
      playerReadyRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        // YouTube may already have torn down its iframe during navigation.
      }
    };
  }, [applyAudio, clearWatchdog, handleClipFailure, hasPlayableClips]);

  useEffect(() => {
    advanceLockedRef.current = false;
    if (!currentKey) {
      clearWatchdog();
      setStatus("empty");
      return;
    }
    if (playerReadyRef.current) loadCurrentClipRef.current();
    else setStatus("loading");
  }, [clearWatchdog, currentKey, playback.generation]);

  useEffect(() => {
    const player = playerRef.current;
    if (player && playerReadyRef.current) applyAudio(player);
  }, [applyAudio, muted, safeVolume]);

  useEffect(() => {
    if (previousSkipNonceRef.current === skipNonce) return;
    previousSkipNonceRef.current = skipNonce;
    advanceRef.current();
  }, [skipNonce]);

  useEffect(() => () => clearWatchdog(), [clearWatchdog]);

  const standbyCopy =
    status === "fallback"
      ? fallbackLabel
      : status === "empty"
        ? "HIGHLIGHT REEL READY"
        : "LOADING HIGHLIGHT REEL";
  const showMedia =
    hasStartedPlayback && status !== "empty" && status !== "fallback";

  return (
    <div
      className="broll-player"
      data-playback-status={status}
      data-testid="broll-player"
      style={playerFrameStyle}
    >
      <style>{brollCss}</style>
      <div className="broll-fallback" style={fallbackStyle} aria-hidden="true">
        <StreamSetFallback active={!showMedia} />
        <div className="broll-set-shade" />
        <div className="broll-standby">
          <span className="broll-standby-kicker">SC2 TOOLS · ARCHIVE FEED</span>
          <span>{standbyCopy}</span>
        </div>
      </div>
      {playableClips.length > 0 ? (
        <div
          className="broll-media"
          data-testid="broll-media"
          style={{ opacity: showMedia ? 1 : 0 }}
        >
          <div ref={mountRef} />
        </div>
      ) : null}
      <div className="broll-vignette" aria-hidden="true" />
      {currentClip && status !== "fallback" ? (
        <div className="broll-title" title={currentClip.title}>
          <span>FROM THE ARCHIVES</span>
          {currentClip.title}
        </div>
      ) : null}
      <span style={srOnlyStyle} role="status" aria-live="polite">
        {status === "playing" && currentClip
          ? `B-roll status: playing ${currentClip.title}`
          : `B-roll status: ${standbyCopy.toLowerCase()}`}
      </span>
    </div>
  );
}

/**
 * Camera-safe generated sets double as a polished no-video/loading canvas.
 * Only the current and previous frames stay mounted, so OBS never decodes all
 * seven 4K files at once. The prior frame remains underneath while the next
 * one fades in, preventing a black flash at the loop seam.
 */
function StreamSetFallback({ active }: { active: boolean }) {
  const [frame, setFrame] = useState({ current: 0, previous: null as number | null });

  useEffect(() => {
    if (!active || STREAM_BACKGROUNDS.length < 2) return;
    const timer = window.setInterval(() => {
      setFrame((previous) => ({
        previous: previous.current,
        current: (previous.current + 1) % STREAM_BACKGROUNDS.length,
      }));
    }, BACKGROUND_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  const current = STREAM_BACKGROUNDS[frame.current];
  const previous =
    frame.previous === null ? null : STREAM_BACKGROUNDS[frame.previous];

  return (
    <div
      className="broll-set"
      data-testid="broll-set-fallback"
      style={{ backgroundColor: current.canvasColor }}
    >
      {previous ? (
        <StreamSetPicture
          key={`previous-${previous.id}`}
          background={previous}
          className="broll-set-layer broll-set-previous"
        />
      ) : null}
      <StreamSetPicture
        key={`current-${current.id}`}
        background={current}
        className="broll-set-layer broll-set-current"
      />
    </div>
  );
}

function StreamSetPicture({
  background,
  className,
}: {
  background: (typeof STREAM_BACKGROUNDS)[number];
  className: string;
}) {
  return (
    <picture className={className}>
      <source media="(min-width: 2560px)" srcSet={background.src4k} />
      <img
        src={background.src1080}
        alt=""
        draggable={false}
        style={{ objectPosition: background.objectPosition }}
      />
    </picture>
  );
}

function normalizeClips(clips: BrollClip[]): BrollClip[] {
  if (!Array.isArray(clips)) return [];
  const seen = new Set<string>();
  const normalized: BrollClip[] = [];
  for (const raw of clips) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const videoId = typeof raw.videoId === "string" ? raw.videoId.trim() : "";
    const startSeconds = Math.max(0, Math.floor(Number(raw.startSeconds)));
    const endSeconds = Math.floor(Number(raw.endSeconds));
    const identity = id || `${videoId}:${startSeconds}:${endSeconds}`;
    if (
      !identity ||
      seen.has(identity) ||
      !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds
    ) {
      continue;
    }
    seen.add(identity);
    normalized.push({
      id: identity,
      title: title || "Untitled highlight",
      videoId,
      startSeconds,
      endSeconds,
    });
  }
  return normalized;
}

function clipKey(clip: BrollClip): string {
  return `${clip.id}:${clip.videoId}:${clip.startSeconds}:${clip.endSeconds}`;
}

function clampVolume(volume: number): number {
  const parsed = Number(volume);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function readYouTubeApi(): YouTubeApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as YouTubeWindow).YT;
  return api?.Player && api.PlayerState ? api : null;
}

function loadYouTubeApi(): Promise<YouTubeApi> {
  const ready = readYouTubeApi();
  if (ready) return Promise.resolve(ready);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const ytWindow = window as YouTubeWindow;
    let settled = false;
    let timeoutId = 0;
    const finish = () => {
      const api = readYouTubeApi();
      if (!api || settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(api);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      reject(new Error("YouTube iframe API did not become ready"));
    };

    const previousReady = ytWindow.onYouTubeIframeAPIReady;
    ytWindow.onYouTubeIframeAPIReady = () => {
      try {
        previousReady?.();
      } finally {
        finish();
      }
    };

    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${YOUTUBE_IFRAME_API}"]`,
    );
    if (!script) {
      script = document.createElement("script");
      script.src = YOUTUBE_IFRAME_API;
      script.async = true;
      script.dataset.sc2Broll = "youtube-api";
      document.head.appendChild(script);
    }
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
    timeoutId = window.setTimeout(fail, API_READY_TIMEOUT_MS);
  }).catch((error) => {
    youtubeApiPromise = null;
    throw error;
  });

  return youtubeApiPromise;
}

const brollCss = `
  .broll-player { isolation: isolate; }
  .broll-media {
    position: absolute;
    z-index: 1;
    top: 50%;
    left: 50%;
    width: 100vw;
    height: 56.25vw;
    min-width: 177.78vh;
    min-height: 100vh;
    transform: translate(-50%, -50%);
    transition: opacity 500ms ease;
    pointer-events: none;
  }
  .broll-media iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    pointer-events: none;
  }
  .broll-fallback { overflow: hidden; }
  .broll-set, .broll-set-layer, .broll-set-layer img, .broll-set-shade {
    position: absolute;
    inset: 0;
  }
  .broll-set { overflow: hidden; }
  .broll-set-layer { display: block; }
  .broll-set-layer img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .broll-set-current {
    animation: brollSetIn 1300ms ease-out both;
  }
  .broll-set-shade {
    background:
      linear-gradient(180deg, rgba(1,4,9,.58) 0%, rgba(1,4,9,.12) 25%, rgba(1,4,9,.08) 65%, rgba(1,4,9,.64) 100%),
      radial-gradient(ellipse at center, transparent 48%, rgba(1,3,8,.38) 100%);
  }
  .broll-standby {
    position: absolute;
    right: clamp(18px, 3vw, 52px);
    bottom: clamp(18px, 3vw, 42px);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    padding: 9px 13px;
    border: 1px solid rgba(143,225,233,.2);
    border-radius: 7px;
    background: rgba(4,10,17,.58);
    color: rgba(238, 248, 255, .88);
    font-size: clamp(10px, 1vw, 16px);
    font-weight: 750;
    letter-spacing: .12em;
    text-align: right;
    text-shadow: 0 0 28px rgba(74, 209, 220, .28);
    backdrop-filter: blur(8px);
  }
  .broll-standby-kicker {
    color: var(--ov-accent, #55dbe0);
    font-size: clamp(9px, .75vw, 13px);
    font-weight: 800;
    letter-spacing: .24em;
  }
  .broll-vignette {
    position: absolute;
    z-index: 2;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(180deg, rgba(2,5,10,.34) 0%, transparent 24%, transparent 70%, rgba(2,5,10,.58) 100%),
      radial-gradient(ellipse at center, transparent 48%, rgba(1,3,8,.46) 100%);
  }
  .broll-title {
    position: absolute;
    z-index: 3;
    left: clamp(18px, 3vw, 52px);
    bottom: clamp(18px, 3vw, 42px);
    max-width: min(62vw, 760px);
    overflow: hidden;
    padding: 10px 15px 11px;
    border: 1px solid rgba(143, 225, 233, .24);
    border-radius: 8px;
    background: linear-gradient(110deg, rgba(4,10,17,.82), rgba(7,16,25,.6));
    box-shadow: 0 12px 38px rgba(0,0,0,.26);
    color: rgba(247,250,255,.9);
    font-size: clamp(11px, 1.15vw, 18px);
    font-weight: 650;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
    backdrop-filter: blur(10px);
  }
  .broll-title span {
    margin-right: 10px;
    color: var(--ov-accent, #55dbe0);
    font-size: .72em;
    font-weight: 850;
    letter-spacing: .14em;
  }
  @keyframes brollSetIn { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .broll-set-current { animation: none; }
    .broll-media { transition: none; }
  }
`;

const playerFrameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  overflow: "hidden",
  background: "#03070d",
  color: "#edf8fb",
  fontFamily: "var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif)",
};

const fallbackStyle: CSSProperties = {
  position: "absolute",
  zIndex: 0,
  inset: 0,
  background:
    "radial-gradient(ellipse at 50% 48%, color-mix(in srgb, var(--ov-accent, #55dbe0) 12%, #09111d) 0%, #07101a 44%, #02050a 100%)",
};

const srOnlyStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
