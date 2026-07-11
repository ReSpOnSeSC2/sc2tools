import { ImageResponse } from "next/og";
import { pct, wrRampHex } from "@/lib/format";
import type { PublicProfileResponse } from "@/components/public-profile/types";

/**
 * Per-page Open Graph card for /p/[handle] — the social preview that
 * makes a shared player link click. Branded, dark, self-contained: only
 * non-sensitive aggregates (name, race, record, win rate) are drawn, so
 * the image can never leak opponent identities.
 *
 * Fetches the same public API the page uses. When the profile is private
 * or missing, it falls back to a neutral branded card rather than
 * revealing that the handle doesn't exist.
 *
 * Rendered with satori (next/og): plain flex layout + inline hex colours
 * only — no Tailwind, no CSS variables.
 */
export const alt = "SC2 Tools player profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand palette (mirrors globals.css dark theme; satori needs literals).
const BG = "#06090e";
const SURFACE = "#0c1017";
const TEXT = "#e7edf0";
const MUTED = "#9aa3b2";
const CYAN = "#3ce0d6";
const TEAL = "#157d8c";
const SUCCESS = "#3ec884";
const DANGER = "#ff6b6b";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  process.env.SC2TOOLS_API_BASE ||
  "http://localhost:8080";

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await loadProfile(handle);

  const displayName = profile?.displayName ?? "SC2 Tools";
  const race = profile?.mainRace ?? null;
  const totals = profile?.totals ?? null;
  const decided = totals ? totals.wins + totals.losses : 0;
  const wrHex = totals && decided > 0 ? wrRampHex(totals.winRate) : CYAN;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: `radial-gradient(1000px 500px at 100% 0%, ${TEAL}44 0%, ${BG} 55%), ${BG}`,
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Eyebrow / wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 14,
              height: 40,
              borderRadius: 6,
              background: CYAN,
              display: "flex",
            }}
          />
          <div
            style={{
              display: "flex",
              fontSize: 30,
              letterSpacing: 4,
              color: CYAN,
              fontWeight: 700,
              textTransform: "uppercase",
            }}
          >
            SC2 Tools
          </div>
          {race ? (
            <div
              style={{
                display: "flex",
                marginLeft: 8,
                padding: "6px 18px",
                borderRadius: 999,
                border: `2px solid ${TEAL}`,
                color: TEXT,
                fontSize: 26,
              }}
            >
              {race}
            </div>
          ) : null}
        </div>

        {/* Name + subtitle */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div
            style={{
              display: "flex",
              fontSize: 88,
              fontWeight: 800,
              color: TEXT,
              lineHeight: 1.02,
            }}
          >
            {truncate(displayName, 26)}
          </div>
          <div style={{ display: "flex", fontSize: 34, color: MUTED }}>
            {totals && totals.games > 0
              ? `StarCraft II player · ${totals.games.toLocaleString()} games tracked`
              : "StarCraft II player profile"}
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: "flex", gap: 24 }}>
          <Stat
            label="Record"
            valueNodes={
              totals ? (
                <div style={{ display: "flex" }}>
                  <span style={{ color: SUCCESS }}>{totals.wins}</span>
                  <span style={{ color: MUTED }}>&nbsp;–&nbsp;</span>
                  <span style={{ color: DANGER }}>{totals.losses}</span>
                </div>
              ) : (
                <span style={{ color: TEXT }}>—</span>
              )
            }
          />
          <Stat
            label="Win rate"
            valueNodes={
              <span style={{ color: wrHex }}>
                {totals && decided > 0 ? pct(totals.winRate) : "—"}
              </span>
            }
          />
          <Stat
            label="Get your own"
            valueNodes={<span style={{ color: CYAN }}>sc2tools.com</span>}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}

function Stat({
  label,
  valueNodes,
}: {
  label: string;
  valueNodes: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "24px 32px",
        borderRadius: 20,
        background: SURFACE,
        border: `2px solid #1c2430`,
        minWidth: 300,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 22,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: MUTED,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", fontSize: 56, fontWeight: 800 }}>
        {valueNodes}
      </div>
    </div>
  );
}

async function loadProfile(handle: string) {
  try {
    const res = await fetch(
      `${API_BASE}/v1/public/profile/${encodeURIComponent(handle)}`,
      { headers: { accept: "application/json" }, next: { revalidate: 300 } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as PublicProfileResponse;
    return data?.profile ?? null;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
