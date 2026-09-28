import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { wrRampHex } from "@/lib/format";
import { fmtCount } from "@/lib/guides/format";
import { ogPercent, type GuideOgCardData, type GuideOgRate } from "@/components/guides/og/guideOgData";

/**
 * The 1200×630 social card shared by the guide `opengraph-image.tsx`
 * routes (build, counter, matchup). Same layout and palette as the
 * profile and review cards (app/p/[handle], app/reviews/[id]).
 *
 * Satori (next/og): inline hex colours only, and `display: "flex"` on
 * every div (a test walks the tree to keep it that way). `card === null`
 * — flag off, API down, unknown slug or below the publishing floor —
 * renders the neutral branded card, which carries no numbers.
 */

export const GUIDE_OG_SIZE = { width: 1200, height: 630 };
export const GUIDE_OG_CONTENT_TYPE = "image/png";

// Brand palette (mirrors globals.css dark theme; satori needs literals).
const BG = "#06090e";
const SURFACE = "#0c1017";
const TEXT = "#e7edf0";
const MUTED = "#9aa3b2";
const CYAN = "#3ce0d6";
const TEAL = "#157d8c";
const LINE = "#1c2430";
const TRACK = "#1a2230";

/**
 * next/og defaults every image to `public, immutable, max-age=31536000`
 * — a year — which would pin a card's numbers past the nightly recompute
 * and an outage's neutral card for good. A real card follows the guide
 * data's 6 h window; the neutral card (API down, unknown or below the
 * floor) is re-checked after 5 minutes.
 */
export const GUIDE_OG_CACHE_CONTROL = "public, max-age=3600, s-maxage=21600, stale-while-revalidate=86400";
export const GUIDE_OG_NEUTRAL_CACHE_CONTROL = "public, max-age=300, s-maxage=300";

const TITLE_MAX_CHARS = 38;
const LABEL_MAX_CHARS = 48;
const PERCENT = 100;
const COIN_FLIP_PCT = 50;
const SITE_LABEL = "sc2tools.com/guides";

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampPct(fraction: number): number {
  return Math.min(PERCENT, Math.max(0, fraction * PERCENT));
}

function Eyebrow({ kind, matchup }: { kind: string; matchup: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ display: "flex", width: 14, height: 40, borderRadius: 6, backgroundColor: CYAN }} />
      <div style={{ display: "flex", fontSize: 28, letterSpacing: 4, color: CYAN, fontWeight: 700, textTransform: "uppercase" }}>
        {`SC2 Tools · ${kind}`}
      </div>
      {matchup ? (
        <div style={{ display: "flex", marginLeft: 8, padding: "6px 18px", borderRadius: 999, border: `2px solid ${TEAL}`, color: TEXT, fontSize: 28, fontWeight: 700 }}>
          {matchup}
        </div>
      ) : null}
    </div>
  );
}

function Headline({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: TEXT, lineHeight: 1.05 }}>
        {truncate(title, TITLE_MAX_CHARS)}
      </div>
      <div style={{ display: "flex", fontSize: 30, color: MUTED }}>{subtitle}</div>
    </div>
  );
}

/** Win-rate bar: fill to the rate, the 95% interval as a band, a 50% tick. */
function RateBar({ rate }: { rate: GuideOgRate }) {
  const fill = clampPct(rate.winRate);
  const colour = wrRampHex(rate.winRate);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
        <div style={{ display: "flex", fontSize: 64, fontWeight: 800, color: colour }}>
          {ogPercent(rate.winRate)}
        </div>
        <div style={{ display: "flex", fontSize: 28, color: TEXT }}>{truncate(rate.label, LABEL_MAX_CHARS)}</div>
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 26, color: MUTED }}>
          {`n = ${fmtCount(rate.games)} games`}
        </div>
      </div>
      <div style={{ display: "flex", position: "relative", width: "100%", height: 28, borderRadius: 14, backgroundColor: TRACK, overflow: "hidden" }}>
        <div style={{ display: "flex", width: `${fill}%`, height: "100%", backgroundColor: colour }} />
        {rate.ci ? (
          <div
            style={{
              display: "flex",
              position: "absolute",
              top: 0,
              left: `${clampPct(rate.ci.low)}%`,
              width: `${Math.max(0, clampPct(rate.ci.high) - clampPct(rate.ci.low))}%`,
              height: "100%",
              backgroundColor: `${TEXT}33`,
            }}
          />
        ) : null}
        <div style={{ display: "flex", position: "absolute", top: 0, left: `${COIN_FLIP_PCT}%`, width: 3, height: "100%", backgroundColor: TEXT }} />
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "16px 28px", borderRadius: 18, backgroundColor: SURFACE, border: `2px solid ${LINE}` }}>
      <div style={{ display: "flex", fontSize: 20, letterSpacing: 2, textTransform: "uppercase", color: MUTED }}>{label}</div>
      <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: TEXT }}>{value}</div>
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        // Separate colour + image: satori rejects a colour layer inside the
        // `background` shorthand ("Invalid background image").
        backgroundColor: BG,
        backgroundImage: `radial-gradient(1000px 500px at 100% 0%, ${TEAL}44 0%, ${BG} 55%)`,
        padding: "56px 72px",
        fontFamily: "sans-serif",
      }}
    >
      {children}
    </div>
  );
}

function SiteMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", marginLeft: "auto", color: CYAN, fontSize: 30, fontWeight: 700 }}>
      {SITE_LABEL}
    </div>
  );
}

function NeutralCard() {
  return (
    <Frame>
      <Eyebrow kind="Build guides" matchup={null} />
      <Headline
        title="StarCraft II build order guides"
        subtitle="Openers ranked by real ladder win rate, with key timings, army and videos."
      />
      <div style={{ display: "flex" }}>
        <SiteMark />
      </div>
    </Frame>
  );
}

/**
 * The card as a React tree (exported for tests; satori renders it).
 *
 * Example: `<GuideOgCard card={buildOgCard(payload)} />`.
 */
export function GuideOgCard({ card }: { card: GuideOgCardData | null }) {
  if (!card) return <NeutralCard />;
  return (
    <Frame>
      <Eyebrow kind={card.kind} matchup={card.matchup} />
      <Headline title={card.title} subtitle={card.subtitle} />
      {card.rate ? <RateBar rate={card.rate} /> : <div style={{ display: "flex" }} />}
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        {card.stats.map((stat) => (
          <StatBox key={stat.label} label={stat.label} value={stat.value} />
        ))}
        <SiteMark />
      </div>
    </Frame>
  );
}

/** PNG response for an opengraph-image route. */
export function renderGuideOgImage(card: GuideOgCardData | null): ImageResponse {
  const cacheControl = card ? GUIDE_OG_CACHE_CONTROL : GUIDE_OG_NEUTRAL_CACHE_CONTROL;
  return new ImageResponse(<GuideOgCard card={card} />, {
    ...GUIDE_OG_SIZE,
    headers: { "cache-control": cacheControl },
  });
}
