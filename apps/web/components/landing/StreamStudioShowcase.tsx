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

/** Always-on stats ticker — endless marquee of live + career segments. */
function TickerDemo() {
  const segments = [
    "SESSION 5–2 · +47 MMR",
    "NEMESIS: DragonKing — 3–9 lifetime",
    "PEAK MMR: 4,712 (Aug 12, 2025)",
    "🔮 CALL IT: !win / !loss — chat is 68% WIN",
    "TIME SUPPLY BLOCKED: 6.3 hrs — build more pylons",
    "HEAD-TO-HEAD vs Printf: 14–9",
  ];
  const strip = segments.map((s, i) => (
    <span
      key={i}
      className="inline-flex items-center gap-2 px-4"
      style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.05em" }}
    >
      <span style={{ color: "#3ec0c7", fontSize: 7 }}>◆</span>
      {s}
    </span>
  ));
  return (
    <div style={{ ...panel, display: "flex", alignItems: "stretch", height: 30, overflow: "hidden", borderRadius: 8, padding: 0 }}>
      <style>{`
        .land-ticker { display: inline-flex; align-items: center; animation: landTicker 26s linear infinite; }
        @keyframes landTicker { to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) { .land-ticker { animation: none; } }
      `}</style>
      <span
        className="flex shrink-0 items-center px-2.5"
        style={{ background: "#3ec0c7", color: "#06251f", fontSize: 10, fontWeight: 900, letterSpacing: "0.14em" }}
      >
        LIVE
      </span>
      <div className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
        <div className="land-ticker">
          {strip}
          <span aria-hidden className="inline-flex">{strip}</span>
        </div>
      </div>
    </div>
  );
}

/** The chat bot answering !rank right in chat. */
function ChatBotDemo() {
  return (
    <div style={{ ...panel, padding: "10px 12px" }}>
      <div className="flex min-w-0 items-baseline gap-1.5 py-0.5" style={{ fontSize: 12 }}>
        <Chip p="twitch" />
        <span style={{ fontWeight: 700, color: "#c9b3ff" }}>ZergRusher</span>
        <span style={{ color: "rgba(255,255,255,0.88)" }}>!rank</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5 py-0.5" style={{ fontSize: 12 }}>
        <span
          className="inline-flex shrink-0 items-center justify-center rounded"
          style={{ background: "#3ec0c7", color: "#06251f", minWidth: 26, height: 14, fontSize: 8, fontWeight: 900, padding: "0 4px" }}
        >
          BOT
        </span>
        <span style={{ fontWeight: 700, color: "#7fd6db" }}>sc2toolsbot</span>
        <span className="min-w-0" style={{ color: "rgba(255,255,255,0.88)" }}>
          @ZergRusher Stalker (Lv 3) · 512 XP — 148 XP to Immortal · 🔮 20 oracle pts
        </span>
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5 py-0.5" style={{ fontSize: 12 }}>
        <span
          className="inline-flex shrink-0 items-center justify-center rounded"
          style={{ background: "#3ec0c7", color: "#06251f", minWidth: 26, height: 14, fontSize: 8, fontWeight: 900, padding: "0 4px" }}
        >
          BOT
        </span>
        <span style={{ fontWeight: 700, color: "#7fd6db" }}>sc2toolsbot</span>
        <span className="min-w-0 truncate" style={{ color: "rgba(255,255,255,0.88)" }}>
          🔮 Result: WIN. Chat said 68% WIN — chat was RIGHT! 14 oracles +10 pts
        </span>
      </div>
    </div>
  );
}

/** Clip log rows with VOD deep-link offsets. */
function ClipsDemo() {
  const rows = [
    { t: "2:12:10", kind: "GAME", reason: "Victory vs GeNieS — 3-game win streak" },
    { t: "1:47:03", kind: "🔥 CHAT", reason: "Chat spiked — 14 messages in 10s" },
  ];
  return (
    <div style={{ ...panel, padding: "10px 12px" }} className="space-y-1.5">
      {rows.map((r) => (
        <div
          key={r.t}
          className="rounded-md px-2 py-1.5"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <div className="flex items-baseline gap-2" style={{ fontSize: 10.5 }}>
            <span
              style={{ color: "#3ec0c7", fontWeight: 700, fontVariantNumeric: "tabular-nums", textDecoration: "underline", textUnderlineOffset: 2 }}
            >
              ▶ {r.t} in
            </span>
            <span style={{ fontWeight: 800, letterSpacing: "0.08em", color: r.kind === "GAME" ? "#3ec0c7" : "#e6b450" }}>
              {r.kind}
            </span>
          </div>
          <div style={{ marginTop: 2, fontSize: 12, color: "rgba(255,255,255,0.88)" }}>
            {r.reason}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Crystal Ball voting window with a live tally bar. */
function OracleDemo() {
  const [winPct, setWinPct] = useState(62);
  useEffect(() => {
    const t = setInterval(
      () => setWinPct((p) => 58 + Math.round(((p * 7) % 13) / 13 * 14)),
      1800,
    );
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ ...panel, borderLeft: "4px solid #9b6ef0", padding: "12px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em", color: "#b493f5" }}>
        🔮 CRYSTAL BALL
      </div>
      <div style={{ marginTop: 5, fontSize: 13.5, fontWeight: 600 }}>
        Call it vs Printf — type <b style={{ color: "#3ec07a" }}>!win</b> or{" "}
        <b style={{ color: "#e05656" }}>!loss</b>
      </div>
      <div style={{ marginTop: 8, height: 9, borderRadius: 999, background: "rgba(224,86,86,0.45)", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${winPct}%`,
            background: "linear-gradient(90deg, #2f9d63, #3ec07a)",
            borderRadius: 999,
            transition: "width 600ms ease",
          }}
        />
      </div>
      <div className="flex items-baseline justify-between" style={{ marginTop: 5, fontSize: 11.5 }}>
        <span style={{ color: "#3ec07a", fontWeight: 800 }}>WIN {winPct}%</span>
        <span style={{ opacity: 0.6 }}>voting locks a minute in</span>
        <span style={{ color: "#e05656", fontWeight: 800 }}>{100 - winPct}%</span>
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
      <Frame title="A chat bot that talks back — !rank, !mmr and Crystal Ball results answered right in chat.">
        <ChatBotDemo />
      </Frame>
      <Frame title="Always-on stats ticker — session, opponent intel and career trivia from your real games.">
        <TickerDemo />
      </Frame>
      <Frame title="Crystal Ball — chat calls the game before it starts, the replay settles who was right.">
        <OracleDemo />
      </Frame>
      <Frame title="Clip moments with VOD timestamps — every highlight becomes a clickable seek link.">
        <ClipsDemo />
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
