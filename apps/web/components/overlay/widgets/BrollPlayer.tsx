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
  StudioBrollVideoFormat,
} from "@/lib/multichat/useStudioState";
import { STREAM_BACKGROUNDS } from "@/lib/streamBackgrounds";
import {
  effectiveBrollPlayback,
  resolveBrollTimeline,
  type BrollTimelinePosition,
} from "./brollTimeline";

const YOUTUBE_IFRAME_API = "https://www.youtube.com/iframe_api";
const API_READY_TIMEOUT_MS = 12_000;
const FAILED_CYCLE_RETRY_MS = 3_000;
const PLAYBACK_BOUNDARY_SLOP_MS = 25;
const DRIFT_CHECK_MS = 2_000;
const MAX_PLAYBACK_DRIFT_SECONDS = 0.35;
const BACKGROUND_ROTATE_MS = 24_000;

export type BrollClip = StudioBrollClip;
export type BrollPlayerConfig = StudioBrollConfig;

export interface BrollPlayerProps extends StudioBrollConfig {
  /** True only for the designated horizontal OBS audio source. */
  audioOwner: boolean;
  /** Selects the matching landscape or portrait source on paired clips. */
  videoFormat?: StudioBrollVideoFormat;
  /** Optional wording for the broadcast-safe canvas shown without video. */
  fallbackLabel?: string;
}

type PlaybackStatus = "empty" | "loading" | "playing" | "fallback";

interface YouTubePlayer {
  destroy(): void;
  getCurrentTime?(): number;
  loadVideoById(options: {
    videoId: string;
    startSeconds: number;
    endSeconds: number;
  }): void;
  mute(): void;
  playVideo(): void;
  seekTo?(seconds: number, allowSeekAhead: boolean): void;
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
  playback: playbackAnchor,
  audioOwner,
  videoFormat = "horizontal",
  fallbackLabel = "HIGHLIGHT REEL STANDBY",
}: BrollPlayerProps) {
  const playableClips = useMemo(() => normalizeClips(clips), [clips]);
  const signature = useMemo(
    () => playableClips.map(clipKey).join("\u001f"),
    [playableClips],
  );
  const sharedPlayback = useMemo(
    () => effectiveBrollPlayback(playbackAnchor, skipNonce, playableClips.length),
    [playbackAnchor, playableClips.length, skipNonce],
  );
  const timelineSignature = `${signature}|${shuffle ? 1 : 0}|${sharedPlayback.epochMs}|${sharedPlayback.revision}|${sharedPlayback.seed}|${sharedPlayback.cursor}`;
  const [timelineState, setTimelineState] = useState<{
    position: BrollTimelinePosition | null;
    generation: number;
  }>(() => ({
    position: resolveBrollTimeline(
      playableClips,
      shuffle,
      sharedPlayback,
      Date.now(),
    ),
    generation: 0,
  }));
  const [status, setStatus] = useState<PlaybackStatus>(
    playableClips.length > 0 ? "loading" : "empty",
  );
  const [hasStartedPlayback, setHasStartedPlayback] = useState(false);

  const safeVolume = clampVolume(volume);
  const currentClip =
    (timelineState.position
      ? playableClips[timelineState.position.clipIndex]
      : null) ?? playableClips[0] ?? null;
  const currentMedia = currentClip
    ? resolveClipMedia(currentClip, videoFormat)
    : null;
  const containLandscapeFallback =
    videoFormat === "vertical" && Boolean(currentClip && !currentClip.vertical);
  const currentKey = currentClip
    ? `${clipKey(currentClip)}:${videoFormat}`
    : "";

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerReadyRef = useRef(false);
  const mutedRef = useRef(muted);
  const volumeRef = useRef(safeVolume);
  const audioOwnerRef = useRef(audioOwner);
  const timelineRef = useRef({
    clips: playableClips,
    shuffle,
    playback: sharedPlayback,
  });
  const positionRef = useRef(timelineState.position);
  const boundaryRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  const driftIntervalRef = useRef<number | null>(null);
  const timelineSignatureRef = useRef(timelineSignature);
  const loadCurrentClipRef = useRef<() => void>(() => undefined);

  timelineRef.current = {
    clips: playableClips,
    shuffle,
    playback: sharedPlayback,
  };
  positionRef.current = timelineState.position;
  mutedRef.current = muted;
  volumeRef.current = safeVolume;
  audioOwnerRef.current = audioOwner;

  const clearPlaybackTimers = useCallback(() => {
    if (boundaryRef.current !== null) {
      window.clearTimeout(boundaryRef.current);
      boundaryRef.current = null;
    }
    if (retryRef.current !== null) {
      window.clearTimeout(retryRef.current);
      retryRef.current = null;
    }
  }, []);

  const applyAudio = useCallback((player: YouTubePlayer) => {
    player.setVolume(audioOwnerRef.current ? volumeRef.current : 0);
    if (
      !audioOwnerRef.current ||
      mutedRef.current ||
      volumeRef.current === 0
    ) player.mute();
    else player.unMute();
  }, []);

  const resolveNow = useCallback(() => {
    const timeline = timelineRef.current;
    return resolveBrollTimeline(
      timeline.clips,
      timeline.shuffle,
      timeline.playback,
      Date.now(),
    );
  }, []);

  const syncToTimeline = useCallback(() => {
    const position = resolveNow();
    positionRef.current = position;
    setTimelineState((previous) => ({
      position,
      generation: previous.generation + 1,
    }));
  }, [resolveNow]);

  const syncToTimelineRef = useRef(syncToTimeline);
  syncToTimelineRef.current = syncToTimeline;

  const scheduleBoundary = useCallback(
    (position: BrollTimelinePosition) => {
      if (boundaryRef.current !== null) {
        window.clearTimeout(boundaryRef.current);
      }
      boundaryRef.current = window.setTimeout(() => {
        boundaryRef.current = null;
        syncToTimelineRef.current();
      }, Math.max(PLAYBACK_BOUNDARY_SLOP_MS, Math.ceil(position.remainingMs) + PLAYBACK_BOUNDARY_SLOP_MS));
    },
    [],
  );

  const handleClipFailure = useCallback(() => {
    const position = resolveNow();
    if (!position) {
      setStatus("empty");
      return;
    }
    setStatus("fallback");
    scheduleBoundary(position);
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    if (position.remainingMs > FAILED_CYCLE_RETRY_MS + 250) {
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        loadCurrentClipRef.current();
      }, FAILED_CYCLE_RETRY_MS);
    }
  }, [resolveNow, scheduleBoundary]);

  const correctPlaybackDrift = useCallback(
    (player: YouTubePlayer) => {
      const expected = resolveNow();
      const shown = positionRef.current;
      if (!expected || !shown) return;
      if (expected.clipIndex !== shown.clipIndex) {
        syncToTimelineRef.current();
        return;
      }
      scheduleBoundary(expected);
      const actualSeconds = player.getCurrentTime?.();
      const expectedClip = timelineRef.current.clips[expected.clipIndex];
      const expectedMedia = resolveClipMedia(expectedClip, videoFormat);
      const expectedSeconds =
        expectedMedia.startSeconds + expected.offsetMs / 1000;
      if (
        typeof actualSeconds === "number" &&
        Number.isFinite(actualSeconds) &&
        Math.abs(actualSeconds - expectedSeconds) >
          MAX_PLAYBACK_DRIFT_SECONDS
      ) {
        player.seekTo?.(expectedSeconds, true);
      }
    },
    [resolveNow, scheduleBoundary, videoFormat],
  );

  const loadCurrentClip = useCallback(() => {
    const player = playerRef.current;
    const position = resolveNow();
    const clipsNow = timelineRef.current.clips;
    const clip = position ? clipsNow[position.clipIndex] : null;
    if (!player || !playerReadyRef.current || !clip || !position) return;
    const media = resolveClipMedia(clip, videoFormat);

    if (
      positionRef.current &&
      positionRef.current.clipIndex !== position.clipIndex
    ) {
      syncToTimelineRef.current();
      return;
    }
    positionRef.current = position;
    clearPlaybackTimers();
    scheduleBoundary(position);
    setStatus("loading");
    try {
      applyAudio(player);
      const offsetSeconds = position.offsetMs / 1000;
      const startSeconds = Math.min(
        media.endSeconds - 0.05,
        media.startSeconds + offsetSeconds,
      );
      player.loadVideoById({
        videoId: media.videoId,
        startSeconds,
        endSeconds: media.endSeconds,
      });
      player.playVideo();
    } catch {
      handleClipFailure();
    }
  }, [
    applyAudio,
    clearPlaybackTimers,
    handleClipFailure,
    resolveNow,
    scheduleBoundary,
    videoFormat,
  ]);

  loadCurrentClipRef.current = loadCurrentClip;

  // Library, shuffle and skip updates carry a new server-owned timeline
  // revision. Re-resolve from wall time instead of asking each player to make
  // an independent random/local advance decision.
  useEffect(() => {
    if (timelineSignatureRef.current === timelineSignature) return;
    timelineSignatureRef.current = timelineSignature;
    clearPlaybackTimers();
    const position = resolveNow();
    positionRef.current = position;
    setTimelineState((previous) => ({
      position,
      generation: previous.generation + 1,
    }));
    if (!position) {
      setHasStartedPlayback(false);
      setStatus("empty");
    }
  }, [clearPlaybackTimers, resolveNow, timelineSignature]);

  // Construct one YouTube player per library. Individual clips are loaded into
  // it so auto-advance does not churn iframes or flash the page background.
  const hasPlayableClips = playableClips.length > 0;
  useEffect(() => {
    if (!hasPlayableClips || !mountRef.current) {
      setStatus("empty");
      return;
    }

    let cancelled = false;
    setHasStartedPlayback(false);
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
              if (driftIntervalRef.current !== null) {
                window.clearInterval(driftIntervalRef.current);
              }
              driftIntervalRef.current = window.setInterval(() => {
                const currentPlayer = playerRef.current;
                if (currentPlayer) correctPlaybackDrift(currentPlayer);
              }, DRIFT_CHECK_MS);
            },
            onStateChange(event) {
              if (cancelled) return;
              if (event.data === YT.PlayerState.PLAYING) {
                if (retryRef.current !== null) {
                  window.clearTimeout(retryRef.current);
                  retryRef.current = null;
                }
                setHasStartedPlayback(true);
                setStatus("playing");
                correctPlaybackDrift(event.target);
              } else if (event.data === YT.PlayerState.ENDED) {
                // Never let an early/late iframe ENDED event choose the next
                // clip locally. Re-resolve the shared clock; if the boundary
                // has not arrived yet, use the safe fallback until it does.
                const expected = resolveNow();
                const shown = positionRef.current;
                if (expected && shown && expected.clipIndex !== shown.clipIndex) {
                  syncToTimelineRef.current();
                } else {
                  handleClipFailure();
                }
              }
            },
            onError() {
              if (cancelled) return;
              handleClipFailure();
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
      clearPlaybackTimers();
      if (driftIntervalRef.current !== null) {
        window.clearInterval(driftIntervalRef.current);
        driftIntervalRef.current = null;
      }
      playerReadyRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      try {
        player?.destroy();
      } catch {
        // YouTube may already have torn down its iframe during navigation.
      }
    };
  }, [
    applyAudio,
    clearPlaybackTimers,
    correctPlaybackDrift,
    handleClipFailure,
    hasPlayableClips,
    resolveNow,
  ]);

  useEffect(() => {
    if (!currentKey) {
      clearPlaybackTimers();
      setStatus("empty");
      return;
    }
    if (playerReadyRef.current) loadCurrentClipRef.current();
    else setStatus("loading");
  }, [clearPlaybackTimers, currentKey, timelineState.generation]);

  useEffect(() => {
    const player = playerRef.current;
    if (player && playerReadyRef.current) applyAudio(player);
  }, [applyAudio, audioOwner, muted, safeVolume]);

  useEffect(() => () => clearPlaybackTimers(), [clearPlaybackTimers]);

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
      data-audio-owner={audioOwner ? "true" : "false"}
      data-clip-id={currentClip?.id ?? ""}
      data-video-format={videoFormat}
      data-video-id={currentMedia?.videoId ?? ""}
      data-playback-status={status}
      data-testid="broll-player"
      style={playerFrameStyle}
    >
      <style>{brollCss}</style>
      <div className="broll-fallback" style={fallbackStyle} aria-hidden="true">
        <StreamSetFallback active={!showMedia} />
        <div className="broll-set-shade" />
        {!showMedia ? (
          <div className="broll-standby">
            <span className="broll-standby-kicker">SC2 TOOLS · ARCHIVE FEED</span>
            <span>{standbyCopy}</span>
          </div>
        ) : null}
      </div>
      {playableClips.length > 0 ? (
        <div
          className="broll-media"
          data-video-fit={containLandscapeFallback ? "contain" : "cover"}
          data-testid="broll-media"
          style={{
            opacity: showMedia ? 1 : 0,
            ...(containLandscapeFallback ? containedLandscapeMediaStyle : {}),
          }}
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
    const rawVertical = raw.vertical;
    const verticalVideoId =
      rawVertical && typeof rawVertical === "object" && !Array.isArray(rawVertical)
        ? String(rawVertical.videoId ?? "").trim()
        : "";
    const verticalStartSeconds =
      rawVertical && typeof rawVertical === "object" && !Array.isArray(rawVertical)
        ? Math.floor(Number(rawVertical.startSeconds))
        : Number.NaN;
    const hasValidVerticalSource =
      /^[A-Za-z0-9_-]{11}$/.test(verticalVideoId) &&
      Number.isFinite(verticalStartSeconds) &&
      verticalStartSeconds >= 0 &&
      verticalStartSeconds + (endSeconds - startSeconds) <= 86_400;
    normalized.push({
      id: identity,
      title: title || "Untitled highlight",
      videoId,
      startSeconds,
      endSeconds,
      ...(hasValidVerticalSource
        ? {
            vertical: {
              videoId: verticalVideoId,
              startSeconds: verticalStartSeconds,
            },
          }
        : {}),
    });
  }
  return normalized;
}

function clipKey(clip: BrollClip): string {
  const vertical = clip.vertical
    ? `:${clip.vertical.videoId}:${clip.vertical.startSeconds}`
    : "";
  return `${clip.id}:${clip.videoId}:${clip.startSeconds}:${clip.endSeconds}${vertical}`;
}

function resolveClipMedia(
  clip: BrollClip,
  videoFormat: StudioBrollVideoFormat,
): { videoId: string; startSeconds: number; endSeconds: number } {
  const durationSeconds = clip.endSeconds - clip.startSeconds;
  if (videoFormat === "vertical" && clip.vertical) {
    return {
      videoId: clip.vertical.videoId,
      startSeconds: clip.vertical.startSeconds,
      endSeconds: clip.vertical.startSeconds + durationSeconds,
    };
  }
  return {
    videoId: clip.videoId,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
  };
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

const containedLandscapeMediaStyle: CSSProperties = {
  width: "100vw",
  height: "56.25vw",
  minWidth: "0px",
  minHeight: "0px",
};

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
