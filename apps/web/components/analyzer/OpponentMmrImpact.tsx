"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import type { NetMmrOpponentRow } from "@/lib/netMmrOpponents";

/**
 * The Opponents list's verified MMR-impact pieces: the two leader cards
 * above the table and the three per-row cells (Net MMR, MMR won, MMR
 * lost). Split out of OpponentsTab.tsx to keep that file readable.
 */

export type MmrImpactLeader = Pick<NetMmrOpponentRow,
  "pulseId" | "toonHandle" | "name" | "displayName" | "netMmr" | "pairs"
>;

/** The MMR-impact fields a table row carries. */
type MmrImpactRow = {
  netMmr?: number | null;
  mmrWon?: number;
  mmrLost?: number;
  mmrPairs?: number;
  mmrAvgDelta?: number | null;
};

export function MmrImpactLeaders({
  mostWon,
  mostLost,
  loading,
  unavailable,
  incomplete,
  onOpen,
}: {
  mostWon: MmrImpactLeader | null | undefined;
  mostLost: MmrImpactLeader | null | undefined;
  loading: boolean;
  unavailable: boolean;
  incomplete: boolean;
  onOpen: (pulseId: string) => void;
}) {
  return (
    <section aria-labelledby="opponent-mmr-impact-heading">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="opponent-mmr-impact-heading"
            className="text-sm font-semibold text-text"
          >
            Opponent MMR impact
          </h2>
          <p className="text-xs text-text-dim">
            Verified game-time MMR from consecutive ranked 1v1 replay pairs.
          </p>
        </div>
        <span className="text-micro uppercase tracking-wider text-text-dim">
          Respects global filters
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {loading ? (
          <>
            <div className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
            <div className="h-24 animate-pulse rounded-xl border-2 border-line bg-bg-surface" />
          </>
        ) : unavailable ? (
          <div
            role="alert"
            className="rounded-xl border-2 border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning sm:col-span-2"
          >
            The verified MMR impact is temporarily unavailable.
          </div>
        ) : incomplete ? (
          <div className="rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-sm text-text-muted sm:col-span-2">
            Grouped MMR leaders need the complete opponent history. Narrow the global filters to see them.
          </div>
        ) : mostWon || mostLost ? (
          <>
            <MmrLeaderCard
              kind="won"
              opponent={mostWon}
              onOpen={onOpen}
            />
            <MmrLeaderCard
              kind="lost"
              opponent={mostLost}
              onOpen={onOpen}
            />
          </>
        ) : (
          <div className="rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-sm text-text-muted sm:col-span-2">
            No verified opponent MMR pairs match the current filters yet.
          </div>
        )}
      </div>
    </section>
  );
}

function MmrLeaderCard({
  kind,
  opponent,
  onOpen,
}: {
  kind: "won" | "lost";
  opponent: MmrImpactLeader | null | undefined;
  onOpen: (pulseId: string) => void;
}) {
  const won = kind === "won";
  const value = opponent?.netMmr || 0;
  const Icon = won ? TrendingUp : TrendingDown;
  if (!opponent) {
    return (
      <div className="rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-sm text-text-dim">
        No net MMR {won ? "gains" : "losses"} in this range.
      </div>
    );
  }
  const name = opponent.name || opponent.displayName || "unnamed opponent";
  const openId = opponent.pulseId || opponent.toonHandle || null;
  const content = (
    <>
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          won ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
        }`}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-micro uppercase tracking-wider text-text-dim">
          {won ? "Most net MMR won from" : "Most net MMR lost to"}
        </span>
        <span className="block truncate font-semibold text-text group-hover:text-accent">
          {name}
        </span>
        <span className="block text-xs tabular-nums text-text-dim">
          {opponent.pairs} verified{" "}
          {opponent.pairs === 1 ? "pair" : "pairs"}
        </span>
      </span>
      <span
        className={`text-lg font-bold tabular-nums ${won ? "text-success" : "text-danger"}`}
      >
        {formatSignedMmr(value)}
      </span>
    </>
  );
  const cardClass =
    "group flex min-h-[92px] items-center gap-3 rounded-xl border-2 border-line bg-bg-surface px-4 py-3 text-left shadow-hard";
  if (!openId) return <div className={cardClass}>{content}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpen(openId)}
      className={`${cardClass} transition hover:-translate-y-0.5 hover:border-accent/60 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      aria-label={`Open ${name}, ${won ? "most net MMR won" : "most net MMR lost"}`}
    >
      {content}
    </button>
  );
}

export function MmrImpactCells({ opponent }: { opponent: MmrImpactRow }) {
  const pairs = opponent.mmrPairs || 0;
  const tracked = pairs > 0 && typeof opponent.netMmr === "number";
  if (!tracked) {
    return (
      <>
        <td className="px-2 py-1 text-right text-text-dim">{"—"}</td>
        <td className="px-2 py-1 text-right text-text-dim">{"—"}</td>
        <td className="px-2 py-1 text-right text-text-dim">{"—"}</td>
      </>
    );
  }
  const net = opponent.netMmr || 0;
  return (
    <>
      <td
        className={`px-2 py-1 text-right leading-tight tabular-nums ${
          net > 0 ? "text-success" : net < 0 ? "text-danger" : "text-text-muted"
        }`}
        title={`${pairs} verified ${pairs === 1 ? "pair" : "pairs"}; average ${formatSignedDecimal(opponent.mmrAvgDelta)} MMR per pair`}
      >
        <span className="font-semibold">{formatSignedMmr(net)}</span>
        <span className="block text-micro font-normal leading-tight text-text-dim">
          {pairs.toLocaleString()} {pairs === 1 ? "pair" : "pairs"}
        </span>
      </td>
      <td className="px-2 py-1 text-right font-medium tabular-nums text-success">
        +{Math.round(opponent.mmrWon || 0).toLocaleString()}
      </td>
      <td className="px-2 py-1 text-right font-medium tabular-nums text-danger">
        -{Math.round(opponent.mmrLost || 0).toLocaleString()}
      </td>
    </>
  );
}

function formatSignedMmr(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString()}`;
}

function formatSignedDecimal(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}
