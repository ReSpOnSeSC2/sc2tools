"use client";

/* eslint-disable @next/next/no-img-element */

import {
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  AlertVisualMotion,
  AlertVisualPreset,
  AlertVisualDecoration,
} from "@/lib/multichat/alerts";
import {
  EVENT_KIND_LABEL,
  type ChatEvent,
} from "@/lib/multichat/events";
import {
  getAlertMediaGrant,
  getAlertMediaGrantServerSnapshot,
  resolveAlertMediaUrl,
  subscribeAlertMediaGrant,
} from "@/lib/multichat/mediaBase";
import { PLATFORM_META } from "./MultiChatMessageList";

export interface ChatAlertCardProps {
  event: ChatEvent;
  preset: AlertVisualPreset;
  motion: AlertVisualMotion;
  /** Settings uses this to keep the demo comfortably inside its preview. */
  preview?: boolean;
}

type AlertCssVars = CSSProperties & {
  "--ca-accent": string;
  "--ca-accent-alt": string;
  "--ca-panel": string;
};

const DECORATION_GLYPHS: Record<AlertVisualDecoration, readonly string[]> = {
  "platform-chip": [],
  scanlines: ["", "", ""],
  sparkles: ["✦", "✧", "✦"],
  confetti: ["▰", "●", "▲", "◆"],
  "speed-lines": ["━", "━", "━"],
  hearts: ["♥", "♡", "♥"],
  coins: ["$", "¢", "$"],
  bills: ["$", "$", "$", "$"],
  stars: ["★", "✦", "★"],
  crowd: ["🙌", "👏", "🙌"],
  lightning: ["ϟ", "⚡", "ϟ"],
  smoke: ["●", "●", "●"],
  halftone: ["•", "•", "•"],
  pixels: ["■", "▪", "■"],
  glitch: ["▥", "▤", "▧"],
  frogs: ["🐸", "🐸", "🐸"],
  crown: ["♛", "♕", "♛"],
  spotlight: ["✦", "✦", "✦"],
  "warning-stripes": ["!", "!", "!"],
  meteors: ["☄", "✦", "☄"],
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Shared, pixel-identical alert renderer for OBS and the Settings preview.
 * Presets are declarative and artwork is CSS-native or locally hosted, so a
 * live alert never depends on a GIF host, remote CORS policy, or meme license.
 */
export function ChatAlertCard({
  event,
  preset,
  motion,
  preview = false,
}: ChatAlertCardProps) {
  const meta = PLATFORM_META[event.platform];
  const panel = panelGradient(preset);
  const variables: AlertCssVars = {
    "--ca-accent": preset.accent,
    "--ca-accent-alt": preset.accentAlt,
    "--ca-panel": panel,
  };
  const hasRenderedMedia = Boolean(preset.animationUrl);
  const classes = [
    "chat-alert-visual",
    `ca-layout-${preset.layout}`,
    `ca-entry-${preset.entry}`,
    `ca-motion-${motion}`,
    `ca-preset-${preset.id}`,
    hasRenderedMedia ? "ca-has-rendered-media" : "",
    preview ? "ca-preview" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={classes}
      style={variables}
      data-alert-preset={preset.id}
      data-alert-layout={preset.layout}
      data-alert-motion={motion}
      data-alert-rendered-media={hasRenderedMedia ? "true" : undefined}
      aria-label={`${EVENT_KIND_LABEL[event.kind]} from ${event.user}`}
    >
      <style>{CHAT_ALERT_CARD_CSS}</style>
      <DecorationField decorations={preset.decorations} />
      <div className="ca-glow" aria-hidden />
      <div className="ca-main">
        <div className="ca-art" aria-hidden="true">
          <PresetArt preset={preset} />
        </div>
        <div className="ca-copy">
          <div className="ca-eyebrow">
            <span
              className="ca-platform"
              style={{ background: meta.color, color: meta.fg }}
            >
              {meta.short}
            </span>
            <span className="ca-kind">{EVENT_KIND_LABEL[event.kind]}</span>
            <span className="ca-callout">{preset.callout}</span>
            {event.amount ? <span className="ca-amount">{event.amount}</span> : null}
          </div>
          <div className="ca-user">{event.user}</div>
          {event.detail ? <div className="ca-detail">{event.detail}</div> : null}
        </div>
      </div>
      <PresetExtra preset={preset} />
    </div>
  );
}

function panelGradient(preset: AlertVisualPreset): string {
  if (preset.id === "emergency-broadcast") {
    return "linear-gradient(135deg, rgba(57,7,11,.98), rgba(19,7,9,.97))";
  }
  if (preset.category === "Money") {
    return "linear-gradient(135deg, rgba(7,35,22,.97), rgba(17,19,12,.96))";
  }
  if (preset.category === "Frog") {
    return "linear-gradient(135deg, rgba(12,34,20,.97), rgba(12,17,15,.96))";
  }
  if (preset.category === "Wholesome") {
    return "linear-gradient(135deg, rgba(39,15,38,.96), rgba(17,20,37,.96))";
  }
  if (preset.category === "Chaos") {
    return "linear-gradient(135deg, rgba(37,8,30,.97), rgba(6,20,35,.97))";
  }
  if (preset.category === "StarCraft") {
    return "linear-gradient(135deg, rgba(7,20,38,.98), rgba(10,12,19,.97))";
  }
  return "var(--ov-panel-bg, linear-gradient(135deg, rgba(11,13,18,.96), rgba(22,26,35,.95)))";
}

function DecorationField({
  decorations,
}: {
  decorations: readonly AlertVisualDecoration[];
}) {
  const particles = decorations
    .flatMap((decoration) =>
      DECORATION_GLYPHS[decoration].map((glyph, glyphIndex) => ({
        decoration,
        glyph,
        glyphIndex,
      })),
    )
    .slice(0, 18);

  if (particles.length === 0) return null;
  return (
    <div className="ca-decorations" aria-hidden="true">
      {particles.map(({ decoration, glyph, glyphIndex }, index) => {
        const particleStyle = {
          "--ca-i": index,
          "--ca-x": `${8 + ((index * 23 + glyphIndex * 11) % 84)}%`,
          "--ca-delay": `${-140 * (index % 7)}ms`,
          "--ca-turn": `${-24 + ((index * 17) % 49)}deg`,
        } as CSSProperties;
        return (
          <span
            key={`${decoration}-${glyphIndex}-${index}`}
            className={`ca-particle ca-deco-${decoration}`}
            style={particleStyle}
          >
            {glyph}
          </span>
        );
      })}
    </div>
  );
}

function PresetArt({ preset }: { preset: AlertVisualPreset }): ReactNode {
  const staticArt = <StaticPresetArt preset={preset} />;
  // Admin-gated media resolves to a presigned URL only for an admin session.
  // A miss is the ordinary non-admin path, not an error: fall back to the
  // code-native art rather than requesting media the viewer cannot read.
  const grant = useSyncExternalStore(
    subscribeAlertMediaGrant,
    getAlertMediaGrant,
    getAlertMediaGrantServerSnapshot,
  );
  const animationUrl = resolveAlertMediaUrl(preset.animationUrl, grant);
  const posterUrl = resolveAlertMediaUrl(preset.animationPosterUrl, grant);

  if (animationUrl) {
    return (
      <PresetAnimation
        key={animationUrl}
        animationUrl={animationUrl}
        posterUrl={posterUrl}
        fallback={staticArt}
      />
    );
  }
  if (posterUrl) {
    return (
      <AnimationPoster
        key={posterUrl}
        posterUrl={posterUrl}
        fallback={staticArt}
      />
    );
  }
  return staticArt;
}

function PresetAnimation({
  animationUrl,
  posterUrl,
  fallback,
}: {
  animationUrl: string;
  posterUrl?: string;
  fallback: ReactNode;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [playbackFailed, setPlaybackFailed] = useState(false);

  if (prefersReducedMotion || playbackFailed) {
    return posterUrl
      ? <AnimationPoster posterUrl={posterUrl} fallback={fallback} />
      : fallback;
  }

  return (
    <video
      className="ca-rendered-media ca-animation"
      src={animationUrl}
      poster={posterUrl}
      data-alert-media="animation"
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      onError={() => setPlaybackFailed(true)}
    />
  );
}

function AnimationPoster({
  posterUrl,
  fallback,
}: {
  posterUrl: string;
  fallback: ReactNode;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  if (posterFailed) return fallback;

  return (
    <img
      className="ca-rendered-media ca-animation-poster"
      src={posterUrl}
      alt=""
      data-alert-media="poster"
      onError={() => setPosterFailed(true)}
    />
  );
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }
  mediaQuery.addListener(onChange);
  return () => mediaQuery.removeListener(onChange);
}

function getReducedMotionSnapshot(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getReducedMotionServerSnapshot(): boolean {
  // Prefer static art until hydration can safely read the viewer's preference.
  return true;
}

function StaticPresetArt({ preset }: { preset: AlertVisualPreset }): ReactNode {
  const assetUrl = preset.assetUrl;
  if (assetUrl) {
    return <img className="ca-sc2-icon" src={assetUrl} alt="" />;
  }

  if (preset.id.startsWith("frog-")) {
    return <FrogArt variant={preset.id} />;
  }
  switch (preset.id) {
    case "laughing-man":
      return (
        <div className="ca-laugh-face">
          <span>🤣</span><b>HA!</b>
        </div>
      );
    case "mind-blown":
      return <div className="ca-mind-blown">🤯</div>;
    case "chef-kiss":
      return <div className="ca-chef">🤌<span>♨</span></div>;
    case "plot-twist":
      return <div className="ca-plot">↻<span>?!</span></div>;
    case "cash-pop":
    case "money-rain":
    case "gold-rush":
      return <BillArt gold={preset.id === "gold-rush"} />;
    case "stonks":
      return <StonksArt />;
    case "jackpot":
      return <SlotArt />;
    case "cash-register":
      return <ReceiptArt />;
    case "raid-boss":
    case "boss-entrance":
      return <div className="ca-boss-art">☠<span>BOSS</span></div>;
    case "airhorn":
      return <div className="ca-airhorn">📣<i>)))</i></div>;
    case "arena-roar":
      return <div className="ca-arena">🙌<span>🙌</span></div>;
    case "level-up":
      return <div className="ca-level">↑<span>LVL</span></div>;
    case "victory-lap":
      return <div className="ca-trophy">🏆</div>;
    case "heart-bloom":
    case "community-hug":
      return <div className="ca-heart">♥</div>;
    case "emergency-broadcast":
      return <div className="ca-siren">!</div>;
    case "meteor-impact":
      return <div className="ca-meteor">☄</div>;
    case "rubber-chicken":
      return <div className="ca-chicken">🐔</div>;
    case "cosmic-rift":
      return <div className="ca-rift">◎<span>✦</span></div>;
    case "glitch-gremlin":
      return <div className="ca-gremlin">👾</div>;
    case "pixel-panel":
      return <div className="ca-pixel-gem">◆</div>;
    case "comic-burst":
      return <div className="ca-word-art">WOW!</div>;
    default:
      return <div className="ca-emoji">{preset.emoji}</div>;
  }
}

function FrogArt({ variant }: { variant: string }) {
  const prop = variant === "frog-sip"
    ? "☕"
    : variant === "frog-bonk"
      ? "🔨"
      : variant === "frog-business"
        ? "▾"
        : variant === "frog-party"
          ? "△"
          : variant === "frog-oracle"
            ? "🔮"
            : "✦";
  return (
    <div className={`ca-frog ca-${variant}`}>
      <i className="ca-frog-eye ca-frog-eye-left" />
      <i className="ca-frog-eye ca-frog-eye-right" />
      <span className="ca-frog-mouth" />
      <b>{prop}</b>
    </div>
  );
}

function BillArt({ gold = false }: { gold?: boolean }) {
  return (
    <div className={`ca-bill${gold ? " ca-bill-gold" : ""}`}>
      <span>$</span><i>THANKS</i>
    </div>
  );
}

function StonksArt() {
  return (
    <div className="ca-chart">
      <i /><i /><i /><i />
      <svg viewBox="0 0 80 48" aria-hidden="true">
        <polyline points="3,42 20,31 32,36 49,18 61,23 77,4" />
        <polyline className="ca-chart-arrow" points="66,4 77,4 77,15" />
      </svg>
    </div>
  );
}

function SlotArt() {
  return (
    <div className="ca-slots"><span>7</span><span>$</span><span>7</span></div>
  );
}

function ReceiptArt() {
  return (
    <div className="ca-receipt"><b>CHA-CHING</b><i>+ + + +</i><span>$$$</span></div>
  );
}

function PresetExtra({ preset }: { preset: AlertVisualPreset }) {
  if (preset.id !== "raid-boss") return null;
  return (
    <div className="ca-boss-meter" aria-hidden="true">
      <span /><b>INCOMING PARTY</b>
    </div>
  );
}

export const CHAT_ALERT_CARD_CSS = `
  .chat-alert-visual {
    position: relative;
    isolation: isolate;
    width: min(100%, 520px);
    min-width: min(240px, 100%);
    min-height: 112px;
    overflow: hidden;
    color: #f8fafc;
    background: var(--ca-panel);
    border: 1px solid color-mix(in srgb, var(--ca-accent) 56%, transparent);
    border-left: 5px solid var(--ca-accent);
    border-radius: var(--ov-radius, 14px);
    box-shadow: 0 14px 38px rgba(0,0,0,.5), 0 0 26px color-mix(in srgb, var(--ca-accent) 18%, transparent);
    font-family: var(--ov-font, Inter, ui-sans-serif, system-ui, sans-serif);
    transform-origin: 35% 50%;
  }
  .chat-alert-visual::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      linear-gradient(105deg, color-mix(in srgb, var(--ca-accent) 16%, transparent), transparent 42%),
      radial-gradient(circle at 88% 12%, color-mix(in srgb, var(--ca-accent-alt) 24%, transparent), transparent 34%);
  }
  .chat-alert-visual::after {
    content: "";
    position: absolute;
    inset: -2px;
    z-index: 4;
    pointer-events: none;
    border-radius: inherit;
    border: 1px solid color-mix(in srgb, var(--ca-accent-alt) 30%, transparent);
    opacity: .65;
  }
  .ca-main { position: relative; z-index: 2; display: grid; grid-template-columns: 86px minmax(0,1fr); gap: 13px; align-items: center; padding: 15px 17px 14px 14px; }
  .ca-art { position: relative; display: grid; place-items: center; width: 78px; height: 78px; filter: drop-shadow(0 7px 9px rgba(0,0,0,.38)); }
  .ca-copy { min-width: 0; }
  .ca-eyebrow { display: flex; min-width: 0; align-items: center; gap: 7px; }
  .ca-platform { display: inline-flex; align-items: center; justify-content: center; min-width: 27px; height: 17px; padding: 0 5px; border-radius: 4px; font-size: 9px; font-weight: 900; letter-spacing: .05em; flex: 0 0 auto; }
  .ca-kind { color: var(--ca-accent-alt); font-size: 10px; line-height: 1; font-weight: 900; letter-spacing: .13em; text-transform: uppercase; white-space: nowrap; }
  .ca-callout { min-width: 0; overflow: hidden; color: rgba(255,255,255,.64); font-size: 9px; line-height: 1; font-weight: 800; letter-spacing: .1em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
  .ca-amount { margin-left: auto; max-width: 44%; padding: 3px 7px; overflow-wrap: anywhere; border: 1px solid color-mix(in srgb, var(--ca-accent) 46%, transparent); border-radius: 999px; color: #fff5b8; background: color-mix(in srgb, var(--ca-accent) 16%, rgba(0,0,0,.3)); font-size: 12px; line-height: 1; font-weight: 900; font-variant-numeric: tabular-nums; text-align: right; }
  .ca-user { margin-top: 7px; overflow-wrap: anywhere; color: #fff; font-size: clamp(18px, 4.4vw, 26px); line-height: 1.08; font-weight: 950; letter-spacing: -.025em; text-shadow: 0 2px 7px rgba(0,0,0,.55); }
  .ca-detail { margin-top: 5px; overflow-wrap: anywhere; color: rgba(255,255,255,.82); font-size: 13px; line-height: 1.3; font-weight: 560; }
  .ca-glow { position: absolute; z-index: 0; left: -36px; top: -38px; width: 160px; height: 160px; border-radius: 50%; background: var(--ca-accent); filter: blur(56px); opacity: .17; }
  .ca-decorations { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none; }
  .ca-particle { --ca-size: 13px; position: absolute; left: var(--ca-x); top: 108%; color: var(--ca-accent-alt); font-size: var(--ca-size); line-height: 1; font-weight: 950; opacity: .7; text-shadow: 0 2px 8px rgba(0,0,0,.4); transform: rotate(var(--ca-turn)); animation: caFloat 2.7s var(--ca-delay) ease-in-out infinite; }
  .ca-deco-bills, .ca-deco-coins { min-width: 20px; padding: 3px 5px; border: 1px solid rgba(255,255,255,.42); color: #d8ffb7; background: rgba(32,116,67,.72); }
  .ca-deco-confetti { --ca-size: 9px; color: hsl(calc(var(--ca-i) * 51deg) 88% 67%); animation-name: caConfetti; }
  .ca-deco-speed-lines { left: -6%; top: calc(14% + var(--ca-i) * 17%); width: 38%; color: var(--ca-accent); transform: none; animation: caSpeed 1.2s var(--ca-delay) linear infinite; }
  .ca-deco-hearts { color: #ff8bc6; animation-name: caHeart; }
  .ca-deco-lightning { color: #fff37c; animation-name: caBlink; }
  .ca-deco-smoke { color: rgba(255,255,255,.28); filter: blur(2px); animation-name: caSmoke; }
  .ca-deco-halftone { top: calc(10% + var(--ca-i) * 25%); color: rgba(255,255,255,.28); animation: none; }
  .ca-deco-pixels, .ca-deco-glitch { animation-name: caPixel; }
  .ca-deco-frogs { --ca-size: 18px; animation-name: caFrogHop; }
  .ca-deco-crown { color: #ffe56c; animation-name: caCrown; }
  .ca-deco-warning-stripes { top: calc(var(--ca-i) * 38%); color: #ffd949; animation-name: caWarning; }
  .ca-deco-meteors { color: #d9f1ff; animation-name: caMeteor; }
  .ca-deco-scanlines { inset: calc(var(--ca-i) * 33%) 0 auto; left: 0; width: 100%; height: 1px; color: transparent; background: rgba(255,255,255,.07); animation: caScan 2s linear infinite; }
  .ca-layout-lower-third { min-height: 88px; border-radius: 8px; }
  .ca-layout-lower-third .ca-main { grid-template-columns: 62px minmax(0,1fr); padding-block: 10px; }
  .ca-layout-lower-third .ca-art { width: 56px; height: 56px; }
  .ca-layout-pill { min-height: 76px; border-left-width: 1px; border-radius: 999px; }
  .ca-layout-pill .ca-main { grid-template-columns: 56px minmax(0,1fr); gap: 9px; padding: 9px 18px 9px 10px; }
  .ca-layout-pill .ca-art { width: 52px; height: 52px; }
  .ca-layout-pill .ca-user { margin-top: 4px; font-size: 18px; }
  .ca-layout-pill .ca-detail { display: none; }
  .ca-layout-burst { border: 3px solid var(--ca-accent); border-left-width: 7px; clip-path: polygon(0 4%, 95% 0, 100% 16%, 97% 100%, 4% 96%); }
  .ca-layout-spotlight { background: radial-gradient(circle at 18% 25%, color-mix(in srgb, var(--ca-accent) 33%, transparent), transparent 35%), var(--ca-panel); }
  .ca-layout-stage { min-height: 142px; border: 2px solid var(--ca-accent); border-left-width: 6px; }
  .ca-layout-stage .ca-main { grid-template-columns: 100px minmax(0,1fr); }
  .ca-layout-stage .ca-art { width: 94px; height: 94px; }
  .ca-emoji, .ca-mind-blown, .ca-chicken, .ca-gremlin, .ca-trophy { font-size: 58px; line-height: 1; }
  .ca-laugh-face { position: relative; font-size: 57px; transform: rotate(-7deg); }
  .ca-laugh-face b { position: absolute; right: -17px; top: -7px; padding: 3px 5px; border: 2px solid #141414; color: #141414; background: #fff36d; font: 950 12px/1 Impact, sans-serif; transform: rotate(13deg); }
  .ca-word-art { padding: 7px 8px; color: #fff; background: var(--ca-accent); border: 3px solid #fff; box-shadow: 4px 4px 0 #111; font: 950 20px/1 Impact, sans-serif; letter-spacing: .02em; transform: rotate(-6deg); }
  .ca-chef { position: relative; font-size: 55px; }.ca-chef span { position: absolute; right: -2px; top: -14px; color: var(--ca-accent); font-size: 25px; }
  .ca-plot { position: relative; display: grid; place-items: center; width: 62px; height: 62px; border: 4px dashed var(--ca-accent); border-radius: 50%; color: var(--ca-accent-alt); font-size: 39px; }.ca-plot span { position: absolute; font-size: 15px; font-weight: 950; }
  .ca-frog { position: relative; width: 66px; height: 53px; margin-top: 9px; border: 3px solid #0b2815; border-radius: 46% 46% 42% 42%; background: linear-gradient(#65d16e,#36a653); box-shadow: inset 0 -8px 0 rgba(0,0,0,.13); }
  .ca-frog-eye { position: absolute; top: -13px; width: 25px; height: 25px; border: 3px solid #0b2815; border-radius: 50%; background: #8dea7f; }.ca-frog-eye::after { content:""; position:absolute; left:7px; top:6px; width:7px; height:9px; border-radius:50%; background:#09140d; }.ca-frog-eye-left { left: 5px; }.ca-frog-eye-right { right: 5px; }
  .ca-frog-mouth { position: absolute; left: 20px; bottom: 10px; width: 24px; height: 9px; border-bottom: 3px solid #103b1f; border-radius: 0 0 50% 50%; }
  .ca-frog b { position: absolute; right: -15px; bottom: -7px; font-size: 25px; transform: rotate(8deg); }.ca-frog-business b { right: 21px; bottom: -17px; color: #ff657f; }.ca-frog-party::before { content:""; position:absolute; left:19px; top:-37px; border-left:14px solid transparent; border-right:14px solid transparent; border-bottom:31px solid #ff5ea8; }.ca-frog-oracle { box-shadow: 0 0 18px #a855f7, inset 0 -8px 0 rgba(0,0,0,.13); }
  .ca-bill { position: relative; display: grid; place-items: center; width: 70px; height: 43px; border: 3px double #c7ffd2; color: #e7ffdf; background: #27794a; box-shadow: 5px 6px 0 rgba(10,49,29,.75); transform: rotate(-7deg); }.ca-bill span { font: 950 25px/1 Georgia,serif; }.ca-bill i { position:absolute; bottom:2px; font: 800 6px/1 sans-serif; letter-spacing:.17em; }.ca-bill-gold { border-color:#fff0a3; color:#392500; background:#f5bd38; box-shadow:5px 6px 0 #7c5512; }
  .ca-chart { position:relative; width:76px; height:58px; border-left:2px solid rgba(255,255,255,.35); border-bottom:2px solid rgba(255,255,255,.35); }.ca-chart i { position:absolute; bottom:0; width:7px; background:color-mix(in srgb,var(--ca-accent) 65%,#fff); }.ca-chart i:nth-child(1){left:9px;height:14px}.ca-chart i:nth-child(2){left:23px;height:23px}.ca-chart i:nth-child(3){left:37px;height:19px}.ca-chart i:nth-child(4){left:51px;height:39px}.ca-chart svg{position:absolute;inset:0;overflow:visible;fill:none;stroke:#d8ff76;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}.ca-chart .ca-chart-arrow{stroke-width:3}
  .ca-slots { display:flex; gap:3px; padding:8px 6px; border:4px solid #ffe46d; border-radius:9px; background:#9b183b; box-shadow:inset 0 0 0 3px #4f0b21; }.ca-slots span{display:grid;place-items:center;width:19px;height:32px;color:#9b183b;background:#fff8d2;border-radius:3px;font:950 20px/1 monospace;}
  .ca-receipt { position:relative; display:flex; flex-direction:column; align-items:center; width:68px; padding:8px 4px 12px; color:#172016; background:#f4ffe9; box-shadow:0 5px 0 #1e5839; font-family:monospace; }.ca-receipt::after{content:"";position:absolute;left:0;bottom:-5px;width:100%;height:7px;background:linear-gradient(135deg,transparent 4px,#f4ffe9 0) 0 0/9px 9px repeat-x}.ca-receipt b{font-size:8px}.ca-receipt i{font-size:7px}.ca-receipt span{font-size:20px;font-weight:950}
  .ca-boss-art { display:grid;place-items:center;width:72px;height:72px;border:3px solid var(--ca-accent);border-radius:50%;color:#fff;background:rgba(0,0,0,.48);font-size:35px;box-shadow:0 0 22px var(--ca-accent);}.ca-boss-art span{position:absolute;bottom:2px;padding:2px 5px;color:#111;background:var(--ca-accent);font-size:8px;font-weight:950;letter-spacing:.12em}
  .ca-airhorn { display:flex;align-items:center;font-size:49px;transform:rotate(-10deg)}.ca-airhorn i{margin-left:-8px;color:var(--ca-accent-alt);font:950 17px/1 monospace;letter-spacing:-.25em}
  .ca-arena { position:relative;font-size:42px}.ca-arena span{position:absolute;left:27px;top:15px;font-size:34px;transform:scaleX(-1)}
  .ca-level { display:grid;place-items:center;width:62px;height:62px;border:3px solid var(--ca-accent);color:var(--ca-accent-alt);background:rgba(0,0,0,.35);font-size:39px;font-weight:950;clip-path:polygon(50% 0,100% 25%,90% 100%,10% 100%,0 25%)}.ca-level span{position:absolute;bottom:7px;font-size:9px;letter-spacing:.14em}
  .ca-heart { color:#ff77b7;font-size:61px;text-shadow:0 0 22px #ff4fa3; }
  .ca-siren { display:grid;place-items:center;width:60px;height:60px;border:5px solid #ffe246;border-radius:50%;color:#ffe246;background:#be1527;font:950 43px/1 Impact,sans-serif;box-shadow:0 0 0 7px rgba(190,21,39,.35)}
  .ca-meteor { color:#fff2c0;font-size:63px;text-shadow:0 0 18px #ff6b35;transform:rotate(-14deg)}
  .ca-rift { position:relative;display:grid;place-items:center;width:67px;height:67px;border:4px solid #a78bfa;border-radius:50%;color:#67e8f9;font-size:53px;box-shadow:inset 0 0 20px #6d28d9,0 0 20px #22d3ee;transform:skew(-5deg)}.ca-rift span{position:absolute;font-size:18px}
  .ca-pixel-gem { color:var(--ca-accent-alt);font:950 54px/1 monospace;text-shadow:5px 0 0 color-mix(in srgb,var(--ca-accent) 70%,transparent);image-rendering:pixelated}
  .ca-sc2-icon { width:72px;height:72px;object-fit:contain;image-rendering:auto;filter:drop-shadow(0 0 11px color-mix(in srgb,var(--ca-accent) 70%,transparent)); }
  .ca-rendered-media { display:block;width:100%;height:100%;object-fit:contain; }
  .ca-has-rendered-media { min-height:160px; }
  .ca-has-rendered-media .ca-main { box-sizing:border-box;min-height:160px;grid-template-columns:144px minmax(0,1fr);gap:16px;padding:9px 18px 9px 10px; }
  .ca-has-rendered-media .ca-art { width:138px;height:138px; }
  .ca-boss-meter { position:relative;z-index:3;margin:-8px 17px 12px 14px;height:12px;overflow:hidden;border:1px solid rgba(255,255,255,.38);border-radius:3px;background:#240710}.ca-boss-meter span{display:block;width:94%;height:100%;background:linear-gradient(90deg,#dc193d,#ff8a45)}.ca-boss-meter b{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:7px;letter-spacing:.18em;text-shadow:0 1px 2px #000}
  .ca-preview { width:100%; }
  .ca-preview .ca-user { font-size:20px; }
  .ca-motion-subtle .ca-particle:nth-child(n+5) { display:none; }
  .ca-motion-subtle .ca-particle { animation-duration:5s; opacity:.42; }
  .ca-motion-maximum { box-shadow:0 16px 42px rgba(0,0,0,.55),0 0 35px color-mix(in srgb,var(--ca-accent) 36%,transparent); }
  .ca-motion-maximum::after { animation:caAura 1.1s ease-in-out infinite alternate; }
  .ca-motion-maximum .ca-particle { --ca-size:18px; animation-duration:1.75s; opacity:.9; }
  .ca-entry-pop { animation:caPop .42s cubic-bezier(.2,1.45,.45,1) both; }
  .ca-entry-slide-up { animation:caSlideUp .48s cubic-bezier(.18,.88,.3,1.12) both; }
  .ca-entry-slide-left { animation:caSlideLeft .48s cubic-bezier(.18,.88,.3,1.12) both; }
  .ca-entry-drop { animation:caDrop .55s cubic-bezier(.2,1.2,.3,1) both; }
  .ca-entry-zoom { animation:caZoom .5s cubic-bezier(.16,1.35,.35,1) both; }
  .ca-entry-bounce { animation:caBounce .62s cubic-bezier(.2,1.2,.3,1) both; }
  .ca-entry-spin { animation:caSpin .62s cubic-bezier(.2,1.1,.25,1) both; }
  .ca-entry-glitch { animation:caGlitch .54s steps(2,end) both; }
  .ca-entry-rise { animation:caRise .58s cubic-bezier(.16,1,.3,1) both; }
  .ca-entry-stamp { animation:caStamp .48s cubic-bezier(.1,1.4,.25,1) both; }
  .ca-preset-laughing-man .ca-art { animation:caWheeze .35s ease-in-out 3 alternate; }
  .ca-preset-frog-party .ca-frog, .ca-preset-frog-hype .ca-frog { animation:caFrogDance .42s ease-in-out 4 alternate; }
  .ca-preset-cash-pop .ca-bill { animation:caCashPop .58s cubic-bezier(.15,1.45,.35,1) both; }
  .ca-preset-stonks .ca-chart svg { stroke-dasharray:120; animation:caDraw 1.2s ease-out both; }
  .ca-preset-jackpot .ca-slots span { animation:caSlot .25s steps(2,end) 4; }
  .ca-preset-emergency-broadcast { animation:caEmergency .48s steps(2,end) both; }
  .ca-preset-maximum-vitality .ca-art { animation:caVitality .75s ease-in-out infinite alternate; }
  @keyframes caPop{from{opacity:0;transform:translateY(-10px) scale(.93)}to{opacity:1;transform:none}}
  @keyframes caSlideUp{from{opacity:0;transform:translateY(45px)}to{opacity:1;transform:none}}
  @keyframes caSlideLeft{from{opacity:0;transform:translateX(75px) skewX(-5deg)}to{opacity:1;transform:none}}
  @keyframes caDrop{0%{opacity:0;transform:translateY(-55px) rotate(-2deg)}70%{opacity:1;transform:translateY(5px) rotate(1deg)}100%{transform:none}}
  @keyframes caZoom{from{opacity:0;transform:scale(.55);filter:blur(5px)}to{opacity:1;transform:none;filter:none}}
  @keyframes caBounce{0%{opacity:0;transform:translateY(-32px) scale(.8)}55%{opacity:1;transform:translateY(7px) scale(1.03)}75%{transform:translateY(-4px)}100%{transform:none}}
  @keyframes caSpin{from{opacity:0;transform:scale(.45) rotate(-14deg)}to{opacity:1;transform:none}}
  @keyframes caGlitch{0%{opacity:0;transform:translate(18px,-5px);filter:hue-rotate(120deg)}35%{opacity:1;transform:translate(-8px,3px)}65%{transform:translate(5px,-2px);filter:hue-rotate(-80deg)}100%{transform:none;filter:none}}
  @keyframes caRise{from{opacity:0;transform:translateY(35px) scaleY(.72)}to{opacity:1;transform:none}}
  @keyframes caStamp{0%{opacity:0;transform:scale(2.2) rotate(-8deg)}65%{opacity:1;transform:scale(.94) rotate(2deg)}100%{transform:none}}
  @keyframes caFloat{0%{transform:translateY(12px) rotate(var(--ca-turn));opacity:0}20%{opacity:.75}100%{transform:translateY(-145px) rotate(calc(var(--ca-turn) + 110deg));opacity:0}}
  @keyframes caConfetti{0%{transform:translateY(-25px) rotate(0);opacity:0}15%{opacity:1}100%{transform:translateY(155px) rotate(480deg);opacity:0}}
  @keyframes caSpeed{from{transform:translateX(-115%);opacity:0}30%{opacity:.65}to{transform:translateX(420%);opacity:0}}
  @keyframes caHeart{0%{transform:translateY(8px) scale(.6);opacity:0}35%{opacity:.85}100%{transform:translateY(-130px) scale(1.3);opacity:0}}
  @keyframes caBlink{0%,45%{opacity:.15}50%,100%{opacity:1}}
  @keyframes caSmoke{from{transform:translateY(15px) scale(.5);opacity:.5}to{transform:translateY(-100px) scale(2);opacity:0}}
  @keyframes caPixel{0%{transform:translate(15px,-5px);opacity:0}30%{opacity:.8}60%{transform:translate(-12px,6px)}100%{opacity:0}}
  @keyframes caFrogHop{0%,100%{transform:translateY(5px) rotate(-8deg)}50%{transform:translateY(-70px) rotate(8deg)}}
  @keyframes caCrown{0%{transform:translateY(-35px) rotate(-12deg);opacity:0}35%,100%{transform:translateY(12px);opacity:.8}}
  @keyframes caWarning{0%,100%{transform:translateX(-22px);opacity:.25}50%{transform:translateX(22px);opacity:.8}}
  @keyframes caMeteor{from{transform:translate(65px,-45px);opacity:0}35%{opacity:1}to{transform:translate(-90px,100px);opacity:0}}
  @keyframes caScan{from{transform:translateY(-40px)}to{transform:translateY(140px)}}
  @keyframes caAura{from{opacity:.35;box-shadow:inset 0 0 4px var(--ca-accent)}to{opacity:1;box-shadow:inset 0 0 19px var(--ca-accent-alt)}}
  @keyframes caWheeze{from{transform:rotate(-8deg) translateY(0)}to{transform:rotate(8deg) translateY(3px)}}
  @keyframes caFrogDance{from{transform:translateY(1px) rotate(-7deg)}to{transform:translateY(-8px) rotate(7deg)}}
  @keyframes caCashPop{from{transform:translateY(55px) scale(.45) rotate(-25deg);opacity:0}to{transform:rotate(-7deg);opacity:1}}
  @keyframes caDraw{from{stroke-dashoffset:120}to{stroke-dashoffset:0}}
  @keyframes caSlot{0%{transform:translateY(-4px)}50%{transform:translateY(4px)}100%{transform:none}}
  @keyframes caEmergency{0%{transform:translateX(-12px);filter:saturate(2)}35%{transform:translateX(10px)}70%{transform:translateX(-5px)}100%{transform:none}}
  @keyframes caVitality{from{transform:scale(.9) rotate(-8deg);filter:hue-rotate(0)}to{transform:scale(1.13) rotate(8deg);filter:hue-rotate(55deg)}}
  @media (max-width: 360px) {
    .ca-main { grid-template-columns:64px minmax(0,1fr);gap:9px;padding:11px; }
    .ca-art { width:60px;height:60px;transform:scale(.82); }
    .ca-has-rendered-media { min-height:126px; }
    .ca-has-rendered-media .ca-main { min-height:126px;grid-template-columns:100px minmax(0,1fr);gap:8px;padding:9px; }
    .ca-has-rendered-media .ca-art { width:96px;height:108px;transform:none; }
    .ca-callout { display:none; }
    .ca-user { font-size:18px; }
    .ca-detail { font-size:11px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-alert-visual, .chat-alert-visual::after, .chat-alert-visual *, .chat-alert-visual *::before, .chat-alert-visual *::after { animation: none !important; transition: none !important; }
    .ca-particle { display: none !important; }
  }
`;
