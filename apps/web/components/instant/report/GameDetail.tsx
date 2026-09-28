"use client";

/**
 * One /try game in detail: what it was (matchup, opponent, map, date,
 * length, result), the pre-game MMRs, both build orders side by side
 * (the analyzer's `BuildOrderColumns`) and the macro timeline (the
 * analyzer's chart and roster, loaded lazily — see OfflineMacroChart).
 * Everything comes from the local payload; each part hides itself when
 * its data is missing.
 *
 * Example:
 *   <GameDetail game={report.games[0]} />
 */
import { useMemo } from "react";
import { Info } from "lucide-react";
import { BuildOrderColumns } from "@/components/analyzer/game/BuildOrderColumns";
import type { ReportGame } from "@/lib/instant/report";
import { gameBuilds, macroChartProps, type GameBuilds } from "@/lib/instant/reportGameDetail";
import { formatMmr, mmrGapLabel, signedMmr } from "@/lib/instant/reportMmr";
import { formatGameClock } from "@/lib/macro";
import { LazyMacroChart } from "./LazyMacroChart";
import { OutcomeMark, formatReportDate } from "./ReportBits";

/** Why a next-game change is not "this game's" MMR change. */
export const NEXT_GAME_MMR_NOTE =
  "Replays record MMR at the start of each game, so this is the change up to your next game here (it includes any games you didn't add).";
/** How the offline build-order times differ from the analyzer's. */
export const BUILD_TIMES_NOTE =
  "Times as the replay records them: buildings when started; units, upgrades and morphs when finished.";
/*
 * A long game logs hundreds of build events (an 18-minute replay: about
 * 800 rows, 3,200 DOM nodes). The columns scroll inside themselves, so
 * most rows start off screen, and styling and laying them all out in one
 * frame took about 60 ms. `content-visibility: auto` lets the browser
 * skip an off-screen row until it scrolls into view; the row stays in
 * the accessibility tree and in find-in-page. 20 px is a row's content
 * height (24 px minus its padding), so the column's scroll height holds.
 */
const OFFSCREEN_ROWS_CLASS = "[&_li]:[content-visibility:auto] [&_li]:[contain-intrinsic-size:auto_20px]";

/**
 * "PvZ vs Squirtuoz" — only the parts the game has.
 *
 * Example:
 *   gameTitle({ matchup: "PvZ", opponentName: null }); // -> "PvZ"
 */
export function gameTitle(game: Pick<ReportGame, "matchup" | "opponentName">): string {
  const vs = game.opponentName ? `vs ${game.opponentName}` : null;
  return [game.matchup, vs].filter(Boolean).join(" ") || "Game";
}

function GameHeading({ game }: { game: ReportGame }) {
  const meta = [
    game.map,
    formatReportDate(game.date),
    game.durationSec !== null ? formatGameClock(game.durationSec) : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <OutcomeMark outcome={game.outcome} />
      <h4 className="min-w-0 break-words font-display text-h4 text-text">{gameTitle(game)}</h4>
      {meta.length > 0 ? <p className="text-caption text-text-muted">{meta.join(" · ")}</p> : null}
    </div>
  );
}

function deltaTone(delta: number): string {
  if (delta > 0) return "text-success";
  return delta < 0 ? "text-danger" : "text-text-muted";
}

/**
 * Pre-game MMRs with the gap, and the change up to your next ladder
 * game on the same queue; nothing when neither exists.
 *
 * Example:
 *   <GameMmr mmr={{ my: 5326, opp: 5118, gap: 208 }} next={null} />
 */
export function GameMmr({ mmr, next }: Pick<ReportGame, "mmr"> & { next: ReportGame["nextMmr"] }) {
  if (!mmr && !next) return null;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-caption" data-testid="report-game-mmr">
      {mmr ? (
        <p className="flex flex-wrap items-baseline gap-x-2 tabular-nums text-text-muted">
          <span className="font-semibold text-text">Pre-game MMR</span>
          <span>
            You <span className="font-semibold text-text">{formatMmr(mmr.my)}</span> · Opp{" "}
            <span className="font-semibold text-text">{formatMmr(mmr.opp)}</span>
          </span>
          <span>· {mmrGapLabel(mmr.gap)}</span>
        </p>
      ) : null}
      {next ? (
        <>
          <p className="tabular-nums text-text-muted">
            <span className="font-semibold text-text">MMR change </span>
            <span className={["font-semibold", deltaTone(next.delta)].join(" ")}>{signedMmr(next.delta)}</span> by your next game
          </p>
          <p className="flex items-start gap-1.5 text-micro text-text-muted">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            <span>{NEXT_GAME_MMR_NOTE}</span>
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * Both build orders side by side. A side without events says so; with
 * no events on either side there is nothing to compare, so nothing
 * renders.
 *
 * Example:
 *   <GameBuildOrders builds={gameBuilds(payload)} opponentName="Squirtuoz" />
 */
export function GameBuildOrders({ builds, opponentName }: { builds: GameBuilds; opponentName: string | null }) {
  if (builds.myStatus === "empty" && builds.oppStatus === "empty") return null;
  return (
    <div className={["space-y-2", OFFSCREEN_ROWS_CLASS].join(" ")} data-testid="report-build-orders">
      <BuildOrderColumns
        myEvents={builds.myEvents}
        oppEvents={builds.oppEvents}
        myLabel={builds.myLabel}
        oppLabel={builds.oppLabel}
        myStatus={builds.myStatus}
        oppStatus={builds.oppStatus}
        myHeadingLabel="You"
        opponentHeadingLabel={opponentName ?? "Opponent"}
      />
      <p className="text-micro text-text-muted">{BUILD_TIMES_NOTE}</p>
    </div>
  );
}

/**
 * The selected game (see module comment).
 *
 * Example:
 *   <GameDetail game={game} />
 */
export function GameDetail({ game }: { game: ReportGame }) {
  const builds = useMemo(() => gameBuilds(game.payload), [game.payload]);
  const chart = useMemo(() => macroChartProps(game.payload, builds), [game.payload, builds]);
  return (
    <div className="min-w-0 space-y-4" data-testid="report-game-detail">
      <GameHeading game={game} />
      <GameMmr mmr={game.mmr} next={game.nextMmr} />
      <GameBuildOrders builds={builds} opponentName={game.opponentName} />
      {chart ? (
        <section
          aria-label="Macro timeline"
          data-testid="report-macro-chart"
          className="min-w-0 overflow-hidden rounded-xl border-2 border-line bg-bg-surface py-4 shadow-hard sm:px-4"
        >
          <LazyMacroChart {...chart} />
        </section>
      ) : null}
    </div>
  );
}
