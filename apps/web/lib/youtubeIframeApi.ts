const YOUTUBE_IFRAME_API = "https://www.youtube.com/iframe_api";
const API_READY_TIMEOUT_MS = 12_000;

export interface YouTubePlayer {
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

function readYouTubeApi(): YouTubeApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as YouTubeWindow).YT;
  return api?.Player && api.PlayerState ? api : null;
}

export function loadYouTubeApi(): Promise<YouTubeApi> {
  const ready = readYouTubeApi();
  if (ready) return Promise.resolve(ready);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const ytWindow = window as YouTubeWindow;
    const previousReady = ytWindow.onYouTubeIframeAPIReady;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API}"]`);
    const script = existing ?? document.createElement("script");
    const clean = () => {
      window.clearTimeout(timeout);
      script.removeEventListener("load", finish);
      script.removeEventListener("error", fail);
      if (ytWindow.onYouTubeIframeAPIReady === readyCallback) ytWindow.onYouTubeIframeAPIReady = previousReady;
    };
    const finish = () => {
      const api = readYouTubeApi();
      if (!api) return;
      clean();
      resolve(api);
    };
    const fail = () => {
      clean();
      if (!existing) script.remove();
      reject(new Error("YouTube iframe API did not become ready"));
    };
    const readyCallback = () => {
      try {
        previousReady?.();
      } finally {
        finish();
      }
    };
    const timeout = window.setTimeout(fail, API_READY_TIMEOUT_MS);
    ytWindow.onYouTubeIframeAPIReady = readyCallback;
    script.addEventListener("load", finish);
    script.addEventListener("error", fail);
    if (!existing) {
      script.src = YOUTUBE_IFRAME_API;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    youtubeApiPromise = null;
    throw error;
  });

  return youtubeApiPromise;
}
