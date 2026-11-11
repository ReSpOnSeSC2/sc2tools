"use client";

/**
 * ClipDialog — "Make a clip" for the map replay. Loaded only when the
 * Clip button is pressed, so none of this (or the recorder) is in the
 * game page's first load.
 *
 * Choose a game-time range (default: the nearest fight ±10 s, at most
 * 60 s), speed, size, scoreboard and watermark; the clip is rendered
 * frame by frame on an off-screen canvas with the replay's own draw
 * code and encoded in this browser — WebM (or MP4 where that is what
 * the browser records), or a GIF from a worker where video recording
 * is unavailable. Nothing is uploaded and nothing runs on a server.
 */

import { formatNumber } from "@/lib/i18n/format";
import { useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Download } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/clientApi";
import type { PublicPlayerSettings } from "@/components/public-profile/types";
import { getMapLayoutUrl } from "@/lib/map-images";
import type { MapPlayback } from "@/lib/mapReplay";
import { resolveEntity, type ReplayView } from "@/lib/replayInspect";
import type { LoadClipSections } from "@/lib/usePlaybackSegments";
import { formatClock } from "@/lib/replayHud";
import type { ReplayVision } from "@/lib/replayVision";
import { spriteAssetsVersion } from "@/lib/spriteSheets";
import {
  CLIP_MAX_SECONDS, CLIP_SIZES, CLIP_SPEEDS, GIF_FPS, GIF_MAX_BYTES, GIF_MAX_VIDEO_SECONDS, GIF_SCALE, VIDEO_BITS_PER_SECOND,
  VIDEO_FPS, VIDEO_MAX_BYTES, clampClipRange, clipFileName, clipFrameCount, clipFrameTime, clipVideoSeconds,
  defaultClipRange, gifFits, parseClipClock, pickVideoMime, type ClipFormat, type ClipRange, type ClipSize, type ClipSpeed,
  type PlaybackWindow,
} from "@/lib/clip/clipPlan";
import type { MapReplayerHandle } from "../../MapReplayer";
import { clipCamera, renderClipFrame, type ClipFrameOptions } from "./clipRender";
import { createClipSurface, type ClipSurface } from "./clipSurface";
import { ClipError, canRecordVideo, recordGifClip, recordVideoClip, type ClipFailure } from "./clipRecorder";

type Status =
  | { kind: "idle"; note?: string }
  | { kind: "preparing" }
  | { kind: "recording"; done: number; total: number }
  | { kind: "done"; url: string; name: string; bytes: number }
  | { kind: "error"; message: string };

const FAILURES: Record<Exclude<ClipFailure, "cancelled">, string> = {
  too_large: "That clip grew past the size limit. Try a shorter range, a higher speed or the smaller size.",
  unsupported: "This browser can't record this clip. Try GIF, or another browser.",
  failed: "The clip couldn't be made. Try again, or try GIF.",
};

const SITE_WATERMARK = "sc2tools.com";

function clipAnnouncement(status: Status, format: ClipFormat): string {
  switch (status.kind) {
    case "preparing": return "Preparing the map.";
    case "recording": {
      const action = format === "gif" ? "Encoding clip" : "Recording clip";
      const percent = Math.min(90, Math.floor(status.done / Math.max(1, status.total) * 10) * 10);
      return percent ? action + ": " + percent + " percent." : action + ".";
    }
    case "done": return "Clip ready to download.";
    case "idle": return status.note ?? "";
    default: return "";
  }
}

/** Whole-second m:ss texts rounded INWARD, so an already-fitted range
 *  never reads as past the game, the loaded section or the 60 s cap. */
function rangeTexts(range: ClipRange): [string, string] {
  const start = Math.max(0, Math.ceil(range.start - 1e-6));
  const end = Math.max(start + 1, Math.floor(range.end + 1e-6));
  return [formatClock(start), formatClock(end)];
}

/** What this browser can encode. Feature detection, not user-agent sniffing. */
function clipSupport(): { video: string | null; gif: boolean } {
  if (typeof document === "undefined") return { video: null, gif: false };
  const probe = document.createElement("canvas");
  const video = canRecordVideo(probe) ? pickVideoMime((mime) => MediaRecorder.isTypeSupported(mime)) : null;
  return { video, gif: typeof Worker !== "undefined" };
}

function loadLayout(mapName: string, signal: AbortSignal): Promise<HTMLImageElement | null> {
  if (signal.aborted) return Promise.reject(new ClipError("cancelled"));
  const url = getMapLayoutUrl(mapName);
  if (!url || typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      image.onload = null;
      image.onerror = null;
    };
    const cancel = () => { cleanup(); image.removeAttribute("src"); reject(new ClipError("cancelled")); };
    const finish = (result: HTMLImageElement | null) => { cleanup(); resolve(result); };
    const timer = setTimeout(() => finish(null), 6000);
    signal.addEventListener("abort", cancel, { once: true });
    image.crossOrigin = "anonymous";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new ClipError("cancelled")); return; }
  const onAbort = () => { clearTimeout(timer); reject(new ClipError("cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

/** Ask for every sprite the range needs, then wait (≤ 2 s) until the
 *  atlases stop arriving, so early frames don't show placeholder dots. */
async function warmUp(draw: (time: number) => void, resetView: () => void, range: ClipRange, signal: AbortSignal) {
  if (signal.aborted) throw new ClipError("cancelled");
  const sample = () => {
    for (let k = 0; k <= 5; k += 1) draw(range.start + ((range.end - range.start) * k) / 6);
    resetView();
  };
  sample();
  const deadline = performance.now() + 2000;
  let version = spriteAssetsVersion();
  let stableSince = performance.now();
  while (performance.now() < deadline && performance.now() - stableSince < 300) {
    await pause(100, signal);
    const next = spriteAssetsVersion();
    if (next !== version) { version = next; stableSince = performance.now(); sample(); }
  }
}

function usePlayerPage(owner: boolean): { text: string | null; enabled: boolean } {
  const request = useApi<PublicPlayerSettings>(owner ? "/v1/me/public-profile" : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  const settings = request.data;
  const text = settings?.enabled && settings.slug ? `sc2tools.com/players/${settings.slug}` : null;
  return { text, enabled: owner };
}

function Choice<T extends string | number>({ name, value, current, onChange, label, disabled }: {
  name: string; value: T; current: T; onChange: (value: T) => void; label: string; disabled?: boolean;
}) {
  return (
    <label className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-caption ${current === value ? "border-accent bg-accent/15 text-text" : "border-border bg-bg-elevated text-text-muted"} ${disabled ? "cursor-not-allowed opacity-50" : "hover:border-accent"}`}>
      <input type="radio" name={name} checked={current === value} disabled={disabled} onChange={() => onChange(value)} className="h-4 w-4 accent-current" />
      {label}
    </label>
  );
}

export default function ClipDialog({
  open,
  onClose,
  playback,
  time,
  vision,
  playbackWindow,
  loadClipSections,
  races,
  owner,
  replayer,
  container,
  onStart,
}: {
  open: boolean;
  onClose: () => void;
  playback: MapPlayback;
  time: number;
  vision: ReplayVision;
  playbackWindow?: PlaybackWindow | null;
  loadClipSections?: LoadClipSections;
  races: { me?: string | null; opp?: string | null };
  /** The owner may brand with their public player page. */
  owner: boolean;
  replayer: MutableRefObject<MapReplayerHandle | null>;
  container?: Element | null;
  /** Pauses playback before frames are rendered. */
  onStart: () => void;
}) {
  const id = useId();
  const support = useMemo(clipSupport, []);
  const rangeWindow = loadClipSections ? null : playbackWindow;
  const initial = useMemo(() => defaultClipRange(playback.stats, time, playback.gameLength, rangeWindow),
    // Only the moment the dialog opened decides the default.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [playback]);
  const [startText, setStartText] = useState(() => rangeTexts(initial)[0]);
  const [endText, setEndText] = useState(() => rangeTexts(initial)[1]);
  const [format, setFormat] = useState<ClipFormat>(support.video ? "video" : "gif");
  const [speed, setSpeed] = useState<ClipSpeed>(1);
  const [size, setSize] = useState<ClipSize>("landscape");
  const [hud, setHud] = useState(true);
  const [watermark, setWatermark] = useState<"site" | "player">("site");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const urlRef = useRef<string | null>(null);
  const playerPage = usePlayerPage(owner);

  useEffect(() => () => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const start = parseClipClock(startText);
  const end = parseClipClock(endText);
  const range: ClipRange | null = start !== null && end !== null && end > start ? { start, end } : null;
  const fitted = range ? clampClipRange(range, playback.gameLength, rangeWindow) : null;
  const rangeError = !range
    ? "Enter a start and an end as m:ss, with the end after the start."
    : fitted && (fitted.start !== range.start || fitted.end !== range.end)
      ? `Clips run up to ${CLIP_MAX_SECONDS} seconds inside ${rangeWindow ? `the loaded section (${formatClock(rangeWindow.start)}–${formatClock(rangeWindow.end)})` : `the game (0:00–${formatClock(playback.gameLength)})`}.`
      : null;
  const gifTooLong = format === "gif" && range !== null && !gifFits(range, speed);
  const fps = format === "gif" ? GIF_FPS : VIDEO_FPS;
  const busy = status.kind === "preparing" || status.kind === "recording";
  const canMake = !busy && !rangeError && !gifTooLong && range !== null && (format === "video" ? !!support.video : support.gif);
  const watermarkText = watermark === "player" && playerPage.text ? playerPage.text : SITE_WATERMARK;

  const setRange = (next: ClipRange) => { const [from, to] = rangeTexts(next); setStartText(from); setEndText(to); };

  const make = async () => {
    if (!range || !canMake || abortRef.current) return;
    onStart();
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: "preparing" });
    const gif = format === "gif";
    const width = Math.round(CLIP_SIZES[size].width * (gif ? GIF_SCALE : 1));
    const height = Math.round(CLIP_SIZES[size].height * (gif ? GIF_SCALE : 1));
    let surface: ClipSurface | undefined;
    try {
      const screen = replayer.current?.snapshot();
      const needsSections = loadClipSections && playbackWindow && (range.start < playbackWindow.start || range.end > playbackWindow.end);
      const sections = needsSections ? await loadClipSections(range, controller.signal)
        : [{ start: range.start, end: range.end, playback }];
      controller.signal.throwIfAborted();
      surface = createClipSurface(width, height, format);
      const { canvas, ctx, captureCanvas, present } = surface;
      const layout = await loadLayout(playback.mapName, controller.signal);
      const initialView = screen ? clipCamera(playback, screen, width, height) : { z: 1, ox: 0, oy: 0 };
      let view: ReplayView = initialView;
      const renderSections = sections.map(section => ({ ...section, follow: screen?.follow
        ? resolveEntity(playback, section.playback, screen.follow) : null }));
      const draw = (frameTime: number) => {
        const section = renderSections.find(value => frameTime >= value.start && frameTime < value.end);
        if (!section) throw new ClipError("failed");
        const options: ClipFrameOptions = {
          playback: section.playback, layout, vision, hud, watermark: watermarkText, races, view, follow: section.follow,
        };
        renderClipFrame(ctx, canvas, frameTime, options);
        view = options.view;
      };
      await warmUp(draw, () => { view = initialView; }, range, controller.signal);
      const count = clipFrameCount(range, speed, fps);
      const render = (index: number) => draw(clipFrameTime(range, speed, fps, index));
      const onProgress = (done: number, total: number) => setStatus({ kind: "recording", done, total });
      setStatus({ kind: "recording", done: 0, total: count });
      const blob = captureCanvas
        ? await recordVideoClip({ count, fps, signal: controller.signal, onProgress, maxBytes: VIDEO_MAX_BYTES, canvas: captureCanvas,
          render: (index) => { render(index); present(); }, mime: support.video!, bitsPerSecond: VIDEO_BITS_PER_SECOND })
        : await recordGifClip({ count, fps, signal: controller.signal, onProgress, maxBytes: GIF_MAX_BYTES, width, height,
          frame: (index) => { render(index); return ctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer; } });
      if (controller.signal.aborted) throw new ClipError("cancelled");
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setStatus({ kind: "done", url, name: clipFileName(range, format, support.video), bytes: blob.size });
    } catch (error) {
      const reason: ClipFailure = controller.signal.aborted ? "cancelled" : error instanceof ClipError ? error.reason : "failed";
      if (abortRef.current === controller) setStatus(reason === "cancelled" ? { kind: "idle", note: "Clip cancelled." } : { kind: "error", message: FAILURES[reason] });
    } finally {
      surface?.dispose();
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const close = () => { abortRef.current?.abort(); onClose(); };
  const videoSeconds = range ? clipVideoSeconds(range, speed) : 0;
  const frames = range ? clipFrameCount(range, speed, fps) : 0;

  return (
    <Modal
      open={open}
      onClose={close}
      portalContainer={container}
      title="Make a clip"
      description="Renders this replay into a short video in your browser. Nothing is uploaded."
      size="lg"
      disableScrimClose={busy}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {busy ? <Button variant="secondary" onClick={() => abortRef.current?.abort()}>Cancel clip</Button> : <Button variant="ghost" onClick={close}>Close</Button>}
          <Button onClick={() => void make()} disabled={!canMake} loading={busy}>Make clip</Button>
        </div>
      }
    >
      <div className="space-y-4 text-caption" data-testid="clip-dialog">
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="font-semibold text-text">Range</legend>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-text-muted">Start (m:ss)
              <input value={startText} onChange={(event) => setStartText(event.target.value)} inputMode="text" autoComplete="off"
                aria-describedby={`${id}-range`} className="min-h-11 w-24 rounded-md border border-border bg-bg-surface px-3 tabular-nums text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            </label>
            <label className="flex flex-col gap-1 text-text-muted">End (m:ss)
              <input value={endText} onChange={(event) => setEndText(event.target.value)} inputMode="text" autoComplete="off"
                aria-describedby={`${id}-range`} className="min-h-11 w-24 rounded-md border border-border bg-bg-surface px-3 tabular-nums text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            </label>
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setRange(defaultClipRange(playback.stats, time, playback.gameLength, rangeWindow))}>Nearest fight</Button>
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => setRange(clampClipRange({ start: time - 10, end: time + 10 }, playback.gameLength, rangeWindow))}>Around {formatClock(time)}</Button>
          </div>
          <p id={`${id}-range`} className={rangeError ? "text-danger" : "text-text-dim"} role={rangeError ? "alert" : undefined}>
            {rangeError ?? `Up to ${CLIP_MAX_SECONDS} seconds of game time.${initial.source === "fight" ? " It starts on the fight nearest the replay clock." : ""}`}
          </p>
        </fieldset>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="font-semibold text-text">Format</legend>
          <div className="flex flex-wrap gap-2">
            <Choice name={`${id}-format`} value="video" current={format} onChange={setFormat} disabled={!support.video}
              label={support.video?.startsWith("video/mp4") ? "Video (MP4)" : "Video (WebM)"} />
            <Choice name={`${id}-format`} value="gif" current={format} onChange={setFormat} disabled={!support.gif} label="GIF" />
          </div>
          <p className="text-text-dim">
            {!support.video && !support.gif ? "This browser can't make clips."
              : !support.video ? "This browser can't record video, so clips are saved as GIF."
                : `GIFs are saved at half size, ${GIF_FPS} frames a second, and up to ${GIF_MAX_VIDEO_SECONDS} seconds long.`}
          </p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="font-semibold text-text">Speed</legend>
            <div className="flex flex-wrap gap-2">
              {CLIP_SPEEDS.map((value) => <Choice key={value} name={`${id}-speed`} value={value} current={speed} onChange={setSpeed} label={`${value}×`} />)}
            </div>
          </fieldset>
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="font-semibold text-text">Size</legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(CLIP_SIZES) as ClipSize[]).map((value) => <Choice key={value} name={`${id}-size`} value={value} current={size} onChange={setSize} label={CLIP_SIZES[value].label} />)}
            </div>
          </fieldset>
        </div>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="font-semibold text-text">On the clip</legend>
          <label className="flex min-h-11 items-center gap-2 text-text">
            <input type="checkbox" checked={hud} onChange={(event) => setHud(event.target.checked)} className="h-4 w-4" />
            Scoreboard: clock, races, supply, workers and army value (no player names)
          </label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Watermark">
            <Choice name={`${id}-mark`} value="site" current={watermark} onChange={setWatermark} label={SITE_WATERMARK} />
            {playerPage.enabled ? (
              <Choice name={`${id}-mark`} value="player" current={watermark} onChange={setWatermark} disabled={!playerPage.text}
                label={playerPage.text ?? "Your player page"} />
            ) : null}
          </div>
          {playerPage.enabled && !playerPage.text ? (
            <p className="text-text-dim">Turn on your public player page in Settings to use its address as the watermark.</p>
          ) : null}
        </fieldset>

        <p className="text-text-muted" data-testid="clip-summary">
          {range ? `${Math.round(range.end - range.start)} s of game time at ${speed}× → ${videoSeconds.toFixed(videoSeconds < 10 ? 1 : 0)} s of ${format === "gif" ? "GIF" : "video"}, ${formatNumber(frames)} frames.` : ""}
          {gifTooLong ? ` A GIF can be up to ${GIF_MAX_VIDEO_SECONDS} seconds: shorten the range or raise the speed.` : ""}
          {format === "video" && range ? " Video records in real time, so this takes about as long as the clip." : ""}
        </p>

        <span role="status" className="sr-only">{clipAnnouncement(status, format)}</span>
        <div className="min-h-6">
          {status.kind === "preparing" ? <p aria-hidden="true">Preparing the map…</p> : null}
          {status.kind === "recording" ? (
            <div className="space-y-1">
              <p aria-hidden="true">{format === "gif" ? "Encoding" : "Recording"} frame {formatNumber(status.done)} of {formatNumber(status.total)}…</p>
              <div role="progressbar" aria-label="Clip progress" aria-valuemin={0} aria-valuemax={status.total} aria-valuenow={status.done} className="h-2 overflow-hidden rounded-full bg-bg-subtle">
                <div className="h-full bg-accent motion-safe:transition-[width]" style={{ width: `${status.total ? (status.done / status.total) * 100 : 0}%` }} />
              </div>
            </div>
          ) : null}
          {status.kind === "done" ? (
            <div className="flex flex-wrap items-center gap-3">
              <a href={status.url} download={status.name} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-accent bg-accent/15 px-4 font-semibold text-text hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <Download className="h-4 w-4" aria-hidden />Download {status.name}
              </a>
              <span className="text-text-dim">{(status.bytes / (1024 * 1024)).toFixed(1)} MB</span>
            </div>
          ) : null}
          {status.kind === "error" ? <p role="alert" className="text-danger">{status.message}</p> : null}
          {status.kind === "idle" && status.note ? <p aria-hidden="true" className="text-text-muted">{status.note}</p> : null}
        </div>
      </div>
    </Modal>
  );
}
