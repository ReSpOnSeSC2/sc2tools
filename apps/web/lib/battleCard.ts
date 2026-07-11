/**
 * battleCard — a per-game, shareable 1200×630 "battle card".
 *
 * One finished game distilled to a single screenshot-friendly image:
 * result headline (win/loss accent), matchup + map, the MMR line, your
 * build vs the opponent's strategy, and one standout stat when it's
 * derivable. Reuses the Arcade ShareCard canvas helpers (background,
 * footer, word-wrap, delivery) so every share surface stays visually
 * consistent and carries the sc2tools.com link-back.
 *
 * No LLM, no network — pure canvas draw off the per-game data the game
 * page already holds client-side. Every field is optional; the renderer
 * and the share-text builder degrade cleanly around whatever's missing.
 */

import {
  CARD_H,
  CARD_PAD,
  CARD_W,
  drawCardBackground,
  drawCardFooter,
  FONT_STACK,
  SHARE_LINK_URL,
  wrapText,
} from "@/components/analyzer/arcade/ShareCard";
import {
  isLossResult,
  isWinResult,
  type GameSummary,
} from "@/components/analyzer/game/types";

const WIN_ACCENT = "#28A06B";
const LOSS_ACCENT = "#DA4150";
const NEUTRAL_ACCENT = "#7DC8FF";

const CONTENT_W = CARD_W - CARD_PAD * 2;

/** "PvZ"-style matchup label from race names/codes; null when unknown. */
function matchupLabel(
  myRace?: string | null,
  oppRace?: string | null,
): string | null {
  const mine = (myRace || "").trim().charAt(0).toUpperCase();
  const theirs = (oppRace || "").trim().charAt(0).toUpperCase();
  if (!/[TPZR]/.test(mine) || !/[TPZR]/.test(theirs)) return null;
  return `${mine}v${theirs}`;
}

/** Big result headline word + the accent that pairs with it. */
function resultHeadline(result?: string | null): { word: string; accent: string } {
  if (isWinResult(result)) return { word: "VICTORY", accent: WIN_ACCENT };
  if (isLossResult(result)) return { word: "DEFEAT", accent: LOSS_ACCENT };
  if (result === "Tie") return { word: "DRAW", accent: NEUTRAL_ACCENT };
  return { word: "GAME", accent: NEUTRAL_ACCENT };
}

/** Sentence-case result word for share TEXT ("Victory", "Defeat"). */
function resultWord(result?: string | null): string {
  if (isWinResult(result)) return "Victory";
  if (isLossResult(result)) return "Defeat";
  if (result === "Tie") return "Draw";
  return "Game";
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * MMR line for a single game. GameSummary carries `myMmr` and the
 * opponent's `mmr` but no signed per-game delta, so the "delta" here is
 * the gap vs the opponent (positive = you outrank them). Returns null
 * when neither MMR is known.
 */
export function mmrLine(game: GameSummary): string | null {
  const mine = typeof game.myMmr === "number" ? game.myMmr : null;
  const opp =
    typeof game.opponent?.mmr === "number" ? game.opponent.mmr : null;
  if (mine === null && opp === null) return null;
  if (mine !== null && opp !== null) {
    const gap = Math.round(mine - opp);
    const sign = gap >= 0 ? "+" : "";
    return `MMR ${Math.round(mine)} vs ${Math.round(opp)} (${sign}${gap})`;
  }
  if (mine !== null) return `MMR ${Math.round(mine)}`;
  return `Opponent MMR ${Math.round(opp as number)}`;
}

/** "You: <build>  vs  <opp strategy>" with graceful fallbacks. */
export function buildsLine(game: GameSummary): string {
  const mine = (game.myBuild || "").trim() || "Unclassified";
  const opp = (game.opponent?.strategy || "").trim() || "Unknown";
  return `You: ${mine}  vs  ${opp}`;
}

/**
 * One standout stat for the card, picked from what the slim game row
 * carries, in priority order. Returns null when nothing is derivable.
 */
export function standoutStat(game: GameSummary): string | null {
  if (typeof game.macroScore === "number") {
    return `Macro score ${Math.round(game.macroScore)}/100`;
  }
  if (typeof game.apm === "number") {
    return `${Math.round(game.apm)} APM`;
  }
  if (typeof game.spq === "number") {
    return `Spending quotient ${Math.round(game.spq)}`;
  }
  if (typeof game.durationSec === "number" && game.durationSec > 0) {
    return `${clock(game.durationSec)} on the clock`;
  }
  return null;
}

/** "PvZ on Goldenaura" / "PvZ" / "on Goldenaura" / "" — context subhead. */
function contextLine(game: GameSummary): string {
  const mu = matchupLabel(game.myRace, game.opponent?.race);
  const map = (game.map || "").trim();
  if (mu && map) return `${mu} on ${map}`;
  if (mu) return mu;
  if (map) return `on ${map}`;
  return "";
}

/**
 * Render the battle card to a PNG Blob. Returns null when there's no DOM
 * (SSR) or no 2D canvas context. Reuses the ShareCard background + footer
 * so the card matches every other share surface.
 */
export async function renderBattleCardPng(
  game: GameSummary | null | undefined,
): Promise<Blob | null> {
  if (!game) return null;
  if (typeof document === "undefined") return null;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const { word, accent } = resultHeadline(game.result);
  drawCardBackground(ctx, accent);
  ctx.textBaseline = "top";

  // Result headline.
  ctx.fillStyle = accent;
  ctx.font = `800 84px ${FONT_STACK}`;
  ctx.fillText(word, CARD_PAD, 56);

  // Context subhead: matchup + map.
  const ctx2 = contextLine(game);
  if (ctx2) {
    ctx.fillStyle = "#e6edf3";
    ctx.font = `600 40px ${FONT_STACK}`;
    ctx.fillText(ctx2, CARD_PAD, 162);
  }

  // Detail rows.
  let y = 250;
  const rows: string[] = [];
  const mmr = mmrLine(game);
  if (mmr) rows.push(mmr);
  rows.push(buildsLine(game));
  const stat = standoutStat(game);
  if (stat) rows.push(stat);

  for (const row of rows) {
    ctx.fillStyle = "#c9d1d9";
    ctx.font = `500 30px ${FONT_STACK}`;
    y = wrapText(ctx, row, CARD_PAD, y, CONTENT_W, 40, 2) + 16;
    if (y > CARD_H - 90) break;
  }

  drawCardFooter(ctx, { brand: "SC2 Tools · Battle Card", tag: contextLine(game) || undefined });

  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}

/**
 * Plain-text share payload for a single game. Always ends with the
 * sc2tools.com link-back so pasted shares point home. Null-safe on every
 * field.
 */
export function battleCardShareText(game: GameSummary | null | undefined): string {
  if (!game) return SHARE_LINK_URL;

  const ctx = contextLine(game);
  const headline = ctx
    ? `${resultWord(game.result)} — ${ctx}`
    : resultWord(game.result);

  const lines = [headline, buildsLine(game)];
  const mmr = mmrLine(game);
  if (mmr) lines.push(mmr);
  const stat = standoutStat(game);
  if (stat) lines.push(stat);

  return `${lines.join("\n")}\n\n${SHARE_LINK_URL}`;
}

/** Suggested download filename for a game's battle card. */
export function battleCardFilename(game: GameSummary | null | undefined): string {
  const mu = game ? matchupLabel(game.myRace, game.opponent?.race) : null;
  const res = game ? resultWord(game.result).toLowerCase() : "game";
  const slug = [mu, res].filter(Boolean).join("-").toLowerCase() || "game";
  return `sc2-${slug}.png`;
}
