"use client";

import { Fragment } from "react";
import { OPPONENT_DETAIL_COLUMNS, opponentRegion, type OpponentColumnKey, type OpponentColumns } from "@/lib/opponentPresentation";
import { GameAnalysisLink } from "../GameAnalysisLink";
import { ReplayDownloadButton } from "../ReplayDownloadButton";
import { notePreview, type Opp } from "./types";

const LINK = "inline-flex min-h-11 items-center rounded text-text underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
export const UNSORTED_OPPONENT_COLUMNS = new Set<OpponentColumnKey>(["latestReplay", "opponentBuildOrder", "topMacroLeaks", "notes"]);
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function gameContext(row: Opp, gameId: string) {
  const identities = (row as Opp & { identities?: Opp[] }).identities || [row];
  const carrier = identities.find(identity => identity.latestGame?.gameId === gameId || identity.latestOppBuildOrder?.gameId === gameId) || row;
  return { pulseId: carrier.pulseId, displayName: carrier.name || row.name || "this opponent" };
}
export function opponentGameLength(value: unknown): string {
  if (!numeric(value)) return "—";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function DetailValue({ row, column }: { row: Opp; column: OpponentColumnKey }) {
  const game = row.latestGame, name = row.name || "this opponent";
  const gameLink = (id: string, hash: string, text: string, label: string) => <GameAnalysisLink gameId={id} opponentContext={gameContext(row, id)} fromLabel="Opponents" hash={hash} prefetch={false} className={LINK} aria-label={label}>{text}</GameAnalysisLink>;
  switch (column) {
    case "region": return opponentRegion(row) || "—";
    case "latestReplay": return game ? <ReplayDownloadButton key={game.gameId} gameId={game.gameId} available={game.replayAvailable} sizeBytes={game.replaySizeBytes} showLabel contextLabel={`latest game vs ${name}`} size="md" /> : "—";
    case "lastResult": return game?.result || "—";
    case "lastGameLength": return opponentGameLength(game?.durationSec);
    case "avgGameLength": return row.duration?.samples ? <span title={`${row.duration.samples} games with a recorded duration`}>{opponentGameLength(row.duration.averageSec)}<span className="block text-micro text-text-dim">{row.duration.samples.toLocaleString()} measured</span></span> : "—";
    case "map": return game?.map || "—";
    case "myBuild": return game?.myBuild ? <span>{game.myBuild}{game.buildPlanned ? <span className="block text-micro text-text-dim">Planned</span> : null}</span> : "—";
    case "opponentBuild": return game?.oppStrategy ? <span>{game.oppStrategy}{game.oppStrategyPlanned ? <span className="block text-micro text-text-dim">Corrected</span> : null}</span> : "—";
    case "macroBreakdown": return game ? gameLink(game.gameId, "#macro", numeric(game.macroScore) ? `${Math.round(game.macroScore)}/100 · Details` : "View breakdown", `Open your macro breakdown for the latest game vs ${name}`) : "—";
    case "topMacroLeaks": return game?.top3Leaks?.length ? game.top3Leaks.slice(0, 3).join(" · ") : "—";
    case "avgMacroScore": return row.macro?.samples && numeric(row.macro.average) ? <span>{Math.round(row.macro.average)}/100<span className="block text-micro text-text-dim">{row.macro.samples.toLocaleString()} measured</span></span> : "—";
    case "opponentBuildOrder": {
      const order = row.latestOppBuildOrder;
      if (order) return row.opponentBuildOrderAvailability === "known"
        ? gameLink(order.gameId, "#builds", "View recorded order", `Open the last recorded opponent build order for ${name}`)
        : gameLink(order.gameId, "#builds", "Inspect recorded game", `Inspect the last known opponent build order for ${name}`);
      if (row.opponentBuildOrderAvailability === "known") return <span className="text-text-dim">No recorded order</span>;
      return game ? gameLink(game.gameId, "#builds", "Inspect latest game", `Inspect opponent build orders in the latest game vs ${name}`) : "—";
    }
    case "buildOrderDate": {
      const order = row.latestOppBuildOrder;
      if (!order || !Number.isFinite(Date.parse(order.date))) return <span className="text-text-dim">{row.opponentBuildOrderAvailability === "known" ? "No recorded order" : "Not indexed"}</span>;
      return <span><time dateTime={order.date} title={new Date(order.date).toLocaleString()}>{new Date(order.date).toLocaleDateString()}</time>{row.opponentBuildOrderAvailability !== "known" ? <span className="block text-micro text-text-dim">Latest known</span> : null}</span>;
    }
    case "notes": {
      const identities = (row as Opp & { identities?: Opp[] }).identities || [row];
      return identities.map(notePreview).filter(Boolean).join(" · ") || "—";
    }
    default: return "—";
  }
}

/** The same saved choices drive the table and readable phone details. */
export function OpponentDetailCells({ row, columns, mobile = false }: { row: Opp; columns: OpponentColumns; mobile?: boolean }) {
  const visible = OPPONENT_DETAIL_COLUMNS.filter(column => columns[column.key]);
  if (mobile) return visible.length ? <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-start gap-x-3 gap-y-2 border-t border-border pt-3 text-caption">{visible.map(column => <Fragment key={column.key}><dt className="text-text-muted">{column.label}</dt><dd className="min-w-0 break-words text-right"><DetailValue row={row} column={column.key} /></dd></Fragment>)}</dl> : null;
  return <>{visible.map(column => <td key={column.key} className="max-w-72 break-words px-2 py-1 text-caption text-text-muted"><DetailValue row={row} column={column.key} /></td>)}</>;
}
