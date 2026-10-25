"use client";

import { DockInput, DockButton } from "./DockControls";

/**
 * DockScenes — Stream Dock control for the full-screen BRB / Starting
 * Soon scene widget. The form's message + countdown are inputs for
 * the NEXT activation (kept fully local — no hydration races); the
 * active scene renders as a status row with its own live countdown
 * and a Go-live button.
 */

import { useEffect, useRef, useState } from "react";
import { formatCountdown } from "@/lib/multichat/countdown";
import type {
  StudioBrollConfig,
  StudioScene,
  StudioTimer,
} from "@/lib/multichat/useStudioState";
import { DockLazyPanel } from "./DockLazyPanel";
import { loadBrollLibrary } from "./dockLazyLoaders";
import { Timer, Shuffle, ListOrdered, Volume2, VolumeX, SkipForward, X } from "lucide-react";

import type { DockPost } from "./dockActions";
import { DockActionNotice, DockSnapshotState, useDockPanelActions } from "./useDockPanelActions";

import { DOCK_QUICK_MINUTES } from "./dockConstants";
import { useSceneMessages } from "./useSceneMessages";
import { STUDIO_SCENE_LABELS, type StudioSceneMode } from "@/lib/multichat/sceneModes";

export function DockTimer({
  timer,
  busy,
  studioReady = true,
  onPost,
}: {
  timer: StudioTimer | null;
  busy: boolean;
  studioReady?: boolean;
  onPost: DockPost;
}) {
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState<number>(5);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!timer) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [timer?.endsAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const remainMs = timer ? Math.max(0, timer.endsAt - nowMs) : null;
  const { run, notice, pending } = useDockPanelActions(studioReady, busy, onPost, {
    clear: () => ({ patch: { timer: null }, message: "Timer cleared" }),
    start: () => ({ patch: { timer: { label: label.trim(), endsAt: Date.now() + Math.round(minutes) * 60_000 } }, message: "Timer started", after: () => { setLabel(""); setMinutes(5); } }),
  });
  if (!studioReady) return <DockSnapshotState />;

  return (
    <fieldset disabled={busy || pending} className="min-w-0"><div className="space-y-2.5">
      <DockActionNotice message={notice} />
      {timer ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-2">
          <span className="text-micro font-bold uppercase tracking-widest text-accent-cyan">
            {timer.label || "Countdown"} on stream
          </span>
          <span className="text-caption tabular-nums text-text">
            {remainMs !== null && remainMs > 0
              ? formatCountdown(remainMs)
              : "TIME!"}
          </span>
          <DockButton
            disabled={busy}
            danger
            onClick={() => void run("clear")}
          >
            Clear
          </DockButton>
        </div>
      ) : (
        <p className="text-caption text-text-dim">
          No countdown showing. Set one below — it appears on the
          Countdown timer widget instantly.
        </p>
      )}
      <DockInput
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Optional label — e.g. next game in…"
        maxLength={40}
        className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <DockInput
          type="number"
          min={1}
          max={720}
          value={minutes}
          onChange={(e) =>
            setMinutes(Math.max(1, Math.min(720, Number(e.target.value) || 1)))
          }
          aria-label="Timer minutes"
          style={{ width: "4rem", maxWidth: "100%" }}
          className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent"
        />
        <span className="text-caption text-text-dim">min</span>
        {DOCK_QUICK_MINUTES.map((m) => (
          <DockButton
            key={m}
            type="button"
            onClick={() => setMinutes(m)}
            className={`rounded border px-2 py-1 text-micro ${
              minutes === m
                ? "border-accent text-text"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {m}m
          </DockButton>
        ))}
        <DockButton
          disabled={busy}
          onClick={() =>
            void run("start")
          }
        >
          <Timer aria-hidden className="h-4 w-4" /> Start timer
        </DockButton>
      </div>
    </div></fieldset>
  );
}

export function DockScenes({
  token,
  brollOpen,
  onBrollOpenChange,
  scene,
  broll,
  busy,
  studioReady = true,
  streamStartMs = null,
  onPost,
}: {
  token?: string;
  brollOpen?: boolean;
  onBrollOpenChange?: (open: boolean) => void;
  scene: StudioScene | null;
  broll: StudioBrollConfig;
  busy: boolean;
  /** Existing go-live mark — when set, "Go live" won't overwrite it. */
  streamStartMs?: number | null;
  studioReady?: boolean;
  onPost: DockPost;
}) {
  const [localBrollOpen, setLocalBrollOpen] = useState(false);
  const [brollLoaded, setBrollLoaded] = useState(false);
  const showBroll = brollOpen ?? localBrollOpen;
  useEffect(() => { if (showBroll) setBrollLoaded(true); }, [showBroll]);
  const [message, setMessage] = useState("");
  const presets = useSceneMessages(token);
  const [minutes, setMinutes] = useState<number>(5);
  const [volumeDraft, setVolumeDraft] = useState(broll.volume);
  const volumeInFlightRef = useRef<number | null>(null);

  useEffect(() => {
    setVolumeDraft(broll.volume);
    if (volumeInFlightRef.current === broll.volume) {
      volumeInFlightRef.current = null;
    }
  }, [broll.volume]);

  // Live remaining time on the status row.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!scene?.countdownEndsAt) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [scene?.countdownEndsAt]);

  const { run, notice, pending } = useDockPanelActions(studioReady, busy, onPost, {
    start: (mode: StudioSceneMode) => ({ patch: { scene: { mode, message: message.trim(), countdownEndsAt: minutes > 0 ? Date.now() + Math.round(minutes) * 60_000 : null } }, message: `Scene set to ${STUDIO_SCENE_LABELS[mode]}`, after: () => { presets.remember(message.trim()); setMessage(""); setMinutes(5); } }),
    live: () => ({ patch: { scene: null, ...(scene?.mode === "starting" && !streamStartMs ? { streamStartMs: Date.now() } : {}) }, message: "Stream is live" }),
    shuffle: () => ({ patch: { broll: { shuffle: !broll.shuffle } }, message: "B-roll order saved" }),
    mute: () => ({ patch: { broll: { muted: !broll.muted } }, message: "B-roll audio saved" }),
    skip: () => ({ patch: { broll: { skipNonce: Math.max(0, broll.skipNonce) + 1 } }, message: "Highlight skipped" }),
    volume: () => ({ patch: { broll: { volume: Math.max(0, Math.min(100, Math.round(volumeDraft))) } }, message: "B-roll volume saved" }),
  });

  const remainMs = scene?.countdownEndsAt
    ? Math.max(0, scene.countdownEndsAt - nowMs)
    : null;

  const commitVolume = (next = volumeDraft) => {
    if (!studioReady || busy) return;
    const volume = Math.max(0, Math.min(100, Math.round(next)));
    if (
      volume === broll.volume ||
      volumeInFlightRef.current === volume
    ) {
      return;
    }
    volumeInFlightRef.current = volume;
    void run("volume").finally(() => {
      if (volumeInFlightRef.current === volume) {
        volumeInFlightRef.current = null;
      }
    });
  };

  const clipCount = broll.clips.length;
  const brollActive = Boolean(scene && clipCount > 0);
  if (!studioReady) return <DockSnapshotState />;

  return (
    <fieldset disabled={busy || pending} className="min-w-0"><div className="space-y-2.5">
      <DockActionNotice message={notice} />
      {scene ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-2">
          <span className="text-micro font-bold uppercase tracking-widest text-accent-cyan">
            {STUDIO_SCENE_LABELS[scene.mode]} on stream
          </span>
          {remainMs !== null ? (
            <span className="text-caption tabular-nums text-text">
              {remainMs > 0 ? formatCountdown(remainMs) : "0:00 — now!"}
            </span>
          ) : null}
          <DockButton
            disabled={busy}
            success
            onClick={() =>
              // Going live off "Starting Soon" is the natural stream
              // start — auto-mark it for the clip log's VOD offsets,
              // but never overwrite a mark the streamer set by hand.
              void run("live")
            }
          >
            Go live
          </DockButton>
        </div>
      ) : (
        <p className="text-caption text-text-dim">
          Stream is live — no scene overlay. Add the{" "}
          <b>Stream scene</b> Browser Source to your OBS scenes
          first (Settings → Overlay).
        </p>
      )}

      <div className="rounded-md border border-border bg-bg-elevated/50 p-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={`rounded-full border px-2 py-0.5 text-micro font-bold uppercase tracking-wider ${
              brollActive
                ? "border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan"
                : clipCount > 0
                  ? "border-border text-text-muted"
                  : "border-danger/40 text-danger"
            }`}
            aria-live="polite"
          >
            {brollActive ? "B-roll active" : clipCount > 0 ? "B-roll ready" : "No b-roll"}
          </span>
          <span className="text-caption text-text-dim">
            {clipCount} {clipCount === 1 ? "highlight clip" : "highlight clips"}
          </span>
        </div>
        <p className="mt-1 text-micro text-text-dim">
          {clipCount > 0
            ? "These highlights belong to this Stream Dock and play automatically behind the compact banner whenever a scene is active."
            : "This Stream Dock has no b-roll. The default stream scene is active; add your own YouTube highlights below to enable it."}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DockButton
            type="button"
            disabled={busy || clipCount < 2}
            aria-pressed={broll.shuffle}
            onClick={() => void run("shuffle")}
            className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text transition-colors hover:border-accent disabled:opacity-50"
          >
            {broll.shuffle ? <Shuffle aria-hidden className="h-4 w-4" /> : <ListOrdered aria-hidden className="h-4 w-4" />}{broll.shuffle ? "Shuffle" : "In order"}
          </DockButton>
          <DockButton
            type="button"
            disabled={busy || clipCount === 0}
            aria-label={broll.muted ? "Unmute b-roll" : "Mute b-roll"}
            aria-pressed={broll.muted}
            onClick={() => void run("mute")}
            className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text transition-colors hover:border-accent disabled:opacity-50"
          >
            {broll.muted ? <VolumeX aria-hidden className="h-4 w-4" /> : <Volume2 aria-hidden className="h-4 w-4" />}{broll.muted ? "Muted" : "Sound"}
          </DockButton>
          <label className="flex min-w-[9rem] flex-1 items-center gap-1.5 text-caption text-text-dim">
            <span className="sr-only">B-roll volume</span>
            <DockInput
              type="range"
              min={0}
              max={100}
              step={1}
              value={volumeDraft}
              disabled={busy || broll.muted || clipCount === 0}
              aria-label="B-roll volume"
              onChange={(event) => setVolumeDraft(Number(event.target.value))}
              onPointerUp={() => commitVolume()}
              onKeyUp={() => commitVolume()}
              onBlur={() => commitVolume()}
              className="min-w-0 flex-1 accent-[var(--accent,#3ec0c7)]"
            />
            <span className="w-9 text-right tabular-nums">{volumeDraft}%</span>
          </label>
          <DockButton
            disabled={busy || !scene || clipCount === 0}
            onClick={() =>
              void run("skip")
            }
          >
            <SkipForward aria-hidden className="h-4 w-4" /> Skip
          </DockButton>
        </div>

        <div className="mt-3">
          <DockButton aria-expanded={showBroll} aria-controls="dock-broll-manager" onClick={() => (onBrollOpenChange ?? setLocalBrollOpen)(!showBroll)}>Manage b-roll</DockButton>
          <div id="dock-broll-manager" hidden={!showBroll} className="mt-2">{showBroll || brollLoaded ? <DockLazyPanel loader={loadBrollLibrary} label="b-roll manager" componentProps={{ embedded: true, broll, busy, studioReady, onPost }} /> : null}</div>
        </div>
      </div>

      <DockInput
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Optional message — e.g. grabbing water, back in 5"
        maxLength={80}
        className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent"
      />

      {presets.messages.length > 0 ? <div aria-label="Saved scene messages" className="flex flex-wrap gap-1.5">
        {presets.messages.map((preset) => <span key={preset} className="inline-flex max-w-full items-center rounded-md border border-border text-caption">
          <DockButton type="button" onClick={() => setMessage(preset)} className="min-w-0 truncate px-2 py-1 text-text">{preset}</DockButton>
          <DockButton type="button" onClick={() => presets.remove(preset)} aria-label={`Remove saved message: ${preset}`} className="px-2 py-1 text-text-muted"><X aria-hidden className="h-4 w-4" /></DockButton>
        </span>)}
      </div> : null}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-caption text-text-dim">Countdown</span>
        <DockInput
          type="number"
          min={0}
          max={720}
          value={minutes}
          onChange={(e) =>
            setMinutes(Math.max(0, Math.min(720, Number(e.target.value) || 0)))
          }
          aria-label="Countdown minutes"
          style={{ width: "4rem", maxWidth: "100%" }}
          className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent"
        />
        <span className="text-caption text-text-dim">min</span>
        {DOCK_QUICK_MINUTES.map((m) => (
          <DockButton
            key={m}
            type="button"
            onClick={() => setMinutes(m)}
            className={`rounded border px-2 py-1 text-micro ${
              minutes === m
                ? "border-accent text-text"
                : "border-border text-text-muted hover:text-text"
            }`}
          >
            {m}m
          </DockButton>
        ))}
        <span className="text-micro text-text-dim">(0 = no countdown)</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(STUDIO_SCENE_LABELS) as StudioSceneMode[]).map((mode) => <DockButton key={mode} disabled={busy} onClick={() => void run("start", mode)}>
          {STUDIO_SCENE_LABELS[mode]}
        </DockButton>)}
      </div>
    </div></fieldset>
  );
}
