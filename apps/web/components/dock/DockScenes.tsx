"use client";

/**
 * DockScenes — Stream Dock control for the full-screen BRB / Starting
 * Soon scene widget. The form's message + countdown are inputs for
 * the NEXT activation (kept fully local — no hydration races); the
 * active scene renders as a status row with its own live countdown
 * and a Go-live button.
 */

import { useEffect, useState } from "react";
import { formatCountdown } from "@/components/overlay/widgets/StreamSceneWidget";
import type { StudioScene, StudioTimer } from "@/lib/multichat/useStudioState";
import { DockButton } from "./DockClient";

const QUICK_MINUTES = [5, 10, 15] as const;

export function DockTimer({
  timer,
  busy,
  onPost,
}: {
  timer: StudioTimer | null;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
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

  return (
    <div className="space-y-2.5">
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
            onClick={() => void onPost({ timer: null })}
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
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Optional label — e.g. next game in…"
        maxLength={40}
        className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="number"
          min={1}
          max={720}
          value={minutes}
          onChange={(e) =>
            setMinutes(Math.max(1, Math.min(720, Number(e.target.value) || 1)))
          }
          aria-label="Timer minutes"
          className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent focus:outline-none"
        />
        <span className="text-caption text-text-dim">min</span>
        {[1, 5, 10, 15].map((m) => (
          <button
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
          </button>
        ))}
        <DockButton
          disabled={busy}
          onClick={() =>
            void onPost({
              timer: {
                label: label.trim(),
                endsAt: Date.now() + Math.round(minutes) * 60_000,
              },
            })
          }
        >
          ⏱ Start timer
        </DockButton>
      </div>
    </div>
  );
}

export function DockScenes({
  scene,
  busy,
  onPost,
}: {
  scene: StudioScene | null;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [minutes, setMinutes] = useState<number>(5);

  // Live remaining time on the status row.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!scene?.countdownEndsAt) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [scene?.countdownEndsAt]);

  const start = (mode: "brb" | "starting") =>
    onPost({
      scene: {
        mode,
        message: message.trim(),
        countdownEndsAt:
          minutes > 0 ? Date.now() + Math.round(minutes) * 60_000 : null,
      },
    });

  const remainMs = scene?.countdownEndsAt
    ? Math.max(0, scene.countdownEndsAt - nowMs)
    : null;

  return (
    <div className="space-y-2.5">
      {scene ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-2">
          <span className="text-micro font-bold uppercase tracking-widest text-accent-cyan">
            {scene.mode === "brb" ? "BRB on stream" : "Starting Soon on stream"}
          </span>
          {remainMs !== null ? (
            <span className="text-caption tabular-nums text-text">
              {remainMs > 0 ? formatCountdown(remainMs) : "0:00 — now!"}
            </span>
          ) : null}
          <DockButton
            disabled={busy}
            danger
            onClick={() => void onPost({ scene: null })}
          >
            Go live
          </DockButton>
        </div>
      ) : (
        <p className="text-caption text-text-dim">
          Stream is live — no scene overlay. Add the{" "}
          <b>BRB / Starting Soon</b> Browser Source to your OBS scenes
          first (Settings → Overlay).
        </p>
      )}

      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Optional message — e.g. grabbing water, back in 5"
        maxLength={80}
        className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-caption text-text-dim">Countdown</span>
        <input
          type="number"
          min={0}
          max={720}
          value={minutes}
          onChange={(e) =>
            setMinutes(Math.max(0, Math.min(720, Number(e.target.value) || 0)))
          }
          aria-label="Countdown minutes"
          className="w-16 rounded-md border border-border bg-bg-elevated px-2 py-1 text-caption tabular-nums text-text focus:border-accent focus:outline-none"
        />
        <span className="text-caption text-text-dim">min</span>
        {QUICK_MINUTES.map((m) => (
          <button
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
          </button>
        ))}
        <span className="text-micro text-text-dim">(0 = no countdown)</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <DockButton disabled={busy} onClick={() => void start("starting")}>
          ▶ Starting soon
        </DockButton>
        <DockButton disabled={busy} onClick={() => void start("brb")}>
          ⏸ BRB
        </DockButton>
      </div>
    </div>
  );
}
