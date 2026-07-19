"use client";

/**
 * StreamStudioShowcase — landing-page demo frames for the Stream
 * Studio: four miniature OBS-style previews (merged 4-platform chat,
 * event alerts, stream goals, Starting Soon countdown) rendered live
 * with obviously-sample content, matching the widgets' real on-stream
 * look. No screenshots, no assets — the same dark panels, platform
 * chips, and animations the overlay actually ships, in miniature.
 *
 * Art direction: sits inside the landing page's editorial layout —
 * the frames themselves are the product's look (dark, glowing), set
 * against a checkerboard hint so the transparency reads honestly.
 */

import { useEffect, useState, type CSSProperties } from "react";

const CHECKER =
  "repeating-conic-gradient(rgba(255,255,255,0.05) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px";

const PLATFORMS: Record<string, { short: string; color: string; fg: string }> = {
  twitch: { short: "TW", color: "#9146ff", fg: "#fff" },
  kick: { short: "KI", color: "#53fc18", fg: "#08130a" },
  youtube: { short: "YT", color: "#ff0000", fg: "#fff" },
  tiktok: { short: "TT", color: "#25f4ee", fg: "#08130a" },
};

const DEMO_CHAT: Array<{ p: keyof typeof PLATFORMS; user: string; text: string }> = [
  { p: "twitch", user: "ZergRusher", text: "that blink micro was clean" },
  { p: "kick", user: "KickViewer", text: "!win calling it now" },
  { p: "youtube", user: "TubeFan", text: "what's the build order here?" },
  { p: "tiktok", user: "tok_scout", text: "chat we are so back" },
  { p: "twitch", user: "GGEnjoyer", text: "CLIP THAT 🔥" },
];

function Frame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="min-w-0">
      <div
        className="relative overflow-hidden rounded-md border border-border p-4"
        style={{ background: `${CHECKER}, #0b0e14` }}
      >
        {children}
      </div>
      <figcaption className="mt-2 text-caption text-text-muted">
        {title}
      </figcaption>
    </figure>
  );
}

const panel: CSSProperties = {
  background: "linear-gradient(135deg, rgba(11,13,18,0.96) 0%, rgba(22,26,35,0.96) 100%)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 12,
  boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
  color: "#e6e8ee",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
};

function Chip({ p }: { p: keyof typeof PLATFORMS }) {
  const m = PLATFORMS[p];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded"
      style={{
        background: m.color,
        color: m.fg,
        minWidth: 22,
        height: 14,
        fontSize: 9,
        fontWeight: 800,
        padding: "0 4px",
      }}
    >
      {m.short}
    </span>
  );
}

/** Rotating merged-chat feed — one new line every 2 s. */
function ChatDemo() {
  const [count, setCount] = useState(3);
  useEffect(() => {
    const t = setInterval(() => setCount((c) => c + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const visible = Array.from(
    { length: Math.min(4, DEMO_CHAT.length) },
    (_, i) => DEMO_CHAT[(count + i) % DEMO_CHAT.length],
  );
  return (
    <div style={{ ...panel, padding: "10px 12px" }}>
      {visible.map((m, i) => (
        <div
          key={`${m.user}:${i}`}
          className="flex min-w-0 items-baseline gap-1.5 py-0.5"
          style={{ fontSize: 12, opacity: i === visible.length - 1 ? 1 : 0.85 }}
        >
          <Chip p={m.p} />
          <span style={{ fontWeight: 700, color: PLATFORMS[m.p].color === "#53fc18" ? "#7ef25a" : "#c9b3ff" }}>
            {m.user}
          </span>
          <span className="truncate" style={{ color: "rgba(255,255,255,0.88)" }}>
            {m.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function AlertDemo() {
  return (
    <div
      style={{
        ...panel,
        borderLeft: "4px solid #3ec0c7",
        padding: "12px 14px",
      }}
    >
      <div className="flex items-center gap-2">
        <Chip p="twitch" />
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.12em",
            color: "#3ec0c7",
          }}
        >
          RAID
        </span>
        <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: "#e6b450" }}>
          250
        </span>
      </div>
      <div style={{ marginTop: 6, fontSize: 17, fontWeight: 800, color: "#fff" }}>
        FriendlyStreamer
      </div>
      <div style={{ marginTop: 2, fontSize: 12, color: "rgba(255,255,255,0.8)" }}>
        raided with a 250-viewer party — airhorn plays
      </div>
    </div>
  );
}

function GoalsDemo() {
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setBump((b) => (b + 1) % 8), 1500);
    return () => clearInterval(t);
  }, []);
  const current = 1168 + bump;
  const pct = Math.min(100, Math.round((current / 1200) * 100));
  return (
    <div style={{ ...panel, padding: "10px 14px" }}>
      <div className="flex items-baseline justify-between gap-2">
        <span
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          Follower goal
        </span>
        <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
          <b style={{ color: "#3ec07a" }}>{current}</b>
          <span style={{ opacity: 0.55 }}> / 1200</span>
        </span>
      </div>
      <div
        style={{
          marginTop: 7,
          height: 10,
          borderRadius: 999,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            borderRadius: 999,
            background: "linear-gradient(90deg, #2f9d63, #3ec07a)",
            boxShadow: "0 0 8px rgba(62,192,122,0.5)",
            transition: "width 600ms ease",
          }}
        />
      </div>
    </div>
  );
}

function SceneDemo() {
  const [left, setLeft] = useState(4 * 60 + 59);
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 299)), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div
      style={{
        ...panel,
        padding: "18px 14px",
        textAlign: "center",
        background:
          "radial-gradient(120% 90% at 50% 10%, #101623 0%, #0a0d14 60%, #05070b 100%)",
      }}
    >
      <div
        style={{
          fontSize: 18,
          fontWeight: 900,
          letterSpacing: "0.22em",
          color: "#fff",
        }}
      >
        STARTING SOON
      </div>
      <div
        style={{
          margin: "8px auto 0",
          width: 120,
          height: 2,
          borderRadius: 999,
          background: "linear-gradient(90deg, transparent, #3ec0c7, transparent)",
        }}
      />
      <div
        style={{
          marginTop: 8,
          fontSize: 34,
          fontWeight: 800,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.06em",
          color: "#3ec0c7",
        }}
      >
        {mm}:{ss}
      </div>
    </div>
  );
}

export function StreamStudioShowcase() {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Frame title="Four chats, one overlay — Twitch, Kick, YouTube & TikTok merged live.">
        <ChatDemo />
      </Frame>
      <Frame title="Event alerts with 50+ sounds — from a classy chime to the airhorn.">
        <AlertDemo />
      </Frame>
      <Frame title="Stream goals, updated from the Stream Dock mid-game.">
        <GoalsDemo />
      </Frame>
      <Frame title="BRB & Starting Soon scenes with a dock-controlled countdown.">
        <SceneDemo />
      </Frame>
    </div>
  );
}
