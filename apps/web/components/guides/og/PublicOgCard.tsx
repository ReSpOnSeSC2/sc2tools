import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GUIDE_OG_SIZE, GUIDE_OG_CONTENT_TYPE } from "./GuideOgCard";
import type { PublicOgCardData } from "./publicOgData";

/* eslint-disable @next/next/no-img-element -- Satori renders img nodes; Next Image cannot render in a social image. */

export { GUIDE_OG_SIZE as PUBLIC_OG_SIZE, GUIDE_OG_CONTENT_TYPE as PUBLIC_OG_CONTENT_TYPE };
const COLORS = { bg: "#06090e", surface: "#0c1017", text: "#e7edf0", muted: "#9aa3b2", cyan: "#3ce0d6", teal: "#157d8c", line: "#1c2430" };
const CACHE = "public, max-age=300, s-maxage=300, stale-while-revalidate=600";
const FALLBACK: PublicOgCardData = { kind: "StarCraft II tools", title: "Builds, replays and better games.", subtitle: "Explore SC2 Tools. Community knowledge, private replay analysis.", stats: [], steps: [] };

/** Satori never fetches a user-controlled image URL. Registry-resolved local
 * PNGs are embedded directly, with a text-only fallback if an asset is absent. */
async function iconsFor(card: PublicOgCardData) {
  return Promise.all(card.steps.map(async step => {
    if (!step.icon || !/^\/icons\/sc2\/[a-z]+\/[a-z0-9-]+\.png$/.test(step.icon)) return null;
    try { return `data:image/png;base64,${(await readFile(path.join(process.cwd(), "public", step.icon))).toString("base64")}`; } catch { return null; }
  }));
}

export function PublicOgCard({ card, icons = [] }: { card: PublicOgCardData; icons?: (string | null)[] }) {
  return <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", flexDirection: "column", justifyContent: "space-between", padding: "48px 64px", backgroundColor: COLORS.bg, backgroundImage: `radial-gradient(1000px 500px at 100% 0%, ${COLORS.teal}44 0%, ${COLORS.bg} 55%)`, color: COLORS.text, fontFamily: "sans-serif" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, color: COLORS.cyan, fontSize: 25, fontWeight: 700 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}><div style={{ display: "flex", width: 12, height: 34, borderRadius: 6, backgroundColor: COLORS.cyan }} />SC2 Tools · {card.kind}</div>
    </div>
    {card.badge ? <div style={{ display: "flex", position: "absolute", right: 64, top: 48, padding: "6px 16px", border: `2px solid ${COLORS.teal}`, borderRadius: 999, color: COLORS.text, fontSize: 25 }}>{card.badge}</div> : null}
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}><div style={{ display: "flex", fontSize: card.title.length > 50 ? 52 : 66, lineHeight: 1.06, fontWeight: 800 }}>{card.title}</div><div style={{ display: "flex", color: COLORS.muted, fontSize: 27 }}>{card.subtitle}</div></div>
    {card.steps.length ? <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", color: COLORS.muted, fontSize: 19 }}>{card.stepsLabel || "Opening rules"}</div>
      <div style={{ display: "flex", gap: 10 }}>{card.steps.map((step, index) => <div key={index} style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 8, padding: 14, borderRadius: 12, border: `1px solid ${COLORS.line}`, backgroundColor: COLORS.surface }}><div style={{ display: "flex", alignItems: "center", gap: 9 }}>{icons[index] ? <img width={36} height={36} src={icons[index]!} alt="" /> : null}<span style={{ display: "flex", fontSize: 25, color: COLORS.cyan }}>{step.time}</span></div><div style={{ display: "flex", fontSize: 20, lineHeight: 1.15 }}>{step.name}</div></div>)}</div>
    </div> : <div style={{ display: "flex" }} />}
    <div style={{ display: "flex", alignItems: "center", gap: 32 }}>{card.stats.map(stat => <div key={stat.label} style={{ display: "flex", flexDirection: "column", gap: 4 }}><div style={{ display: "flex", fontSize: 35, fontWeight: 700 }}>{stat.value}</div><div style={{ display: "flex", fontSize: 20, color: COLORS.muted }}>{stat.label}</div></div>)}<div style={{ display: "flex", marginLeft: "auto", color: COLORS.cyan, fontSize: 28, fontWeight: 700 }}>sc2tools.com</div></div>
  </div>;
}

export async function renderPublicOgImage(value: PublicOgCardData | null) {
  const card = value ?? FALLBACK, icons = await iconsFor(card);
  return new ImageResponse(<PublicOgCard card={card} icons={icons} />, { ...GUIDE_OG_SIZE, headers: { "Cache-Control": value ? CACHE : "public, max-age=60, s-maxage=60" } });
}
