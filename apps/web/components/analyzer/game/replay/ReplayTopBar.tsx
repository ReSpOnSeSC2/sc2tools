"use client";

/**
 * ReplayTopBar — the mirrored scoreboard across the top of the stage.
 *
 * One row: you on the left, the opponent on the right, the game clock
 * in the middle. Reading OUTWARD from the clock each side shows supply,
 * workers, minerals, gas, army value and kills, so the two sides are
 * directly comparable at a glance.
 *
 * Minerals and gas are only rendered when the host supplied a banked
 * series — the replay payload has no banked-resource data and the bar
 * shows nothing rather than a plausible-looking zero (see
 * ``lib/replayHud`` header).
 */

import { memo } from "react";
import { resolveRaceIcon } from "@/lib/sc2-icons";
import { formatClock, type HudSide, type ReplaySide } from "@/lib/replayHud";
import { SIDE_COLOR, sideLabel } from "./replayTheme";

interface StatDef {
  key: string;
  label: string;
  value: string;
  /** Muted stats sit behind the ones that decide games. */
  dim?: boolean;
}

function statsFor(side: HudSide): StatDef[] {
  const out: StatDef[] = [
    {
      key: "supply",
      label: "supply",
      value: `${Math.round(side.supplyUsed)}/${side.supplyCap || "—"}`,
    },
    { key: "workers", label: "workers", value: `${Math.round(side.workers)}` },
  ];
  if (side.minerals !== null) {
    out.push({
      key: "minerals",
      label: "minerals banked",
      value: `${Math.round(side.minerals)}`,
    });
  }
  if (side.gas !== null) {
    out.push({ key: "gas", label: "gas banked", value: `${Math.round(side.gas)}` });
  }
  out.push(
    { key: "army", label: "army value", value: `${Math.round(side.armyValue)}` },
    { key: "kills", label: "kills", value: `${side.kills}`, dim: true },
  );
  return out;
}

/** Tiny glyph per stat so the row stays readable without a legend. */
const GLYPH: Readonly<Record<string, string>> = {
  supply: "▲",
  workers: "⛏",
  minerals: "◆",
  gas: "●",
  army: "⚔",
  kills: "☠",
};

function StatCell({
  stat,
  label,
  mirrored,
}: {
  stat: StatDef;
  label: string;
  mirrored: boolean;
}) {
  return (
    <span
      className={`inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums ${
        mirrored ? "flex-row-reverse" : ""
      }`}
      title={`${label} — ${stat.label}`}
    >
      <span aria-hidden className="text-[0.6rem] leading-none text-text-dim">
        {GLYPH[stat.key] ?? ""}
      </span>
      <span
        className={
          stat.dim
            ? "text-caption font-medium text-text-muted"
            : "text-caption font-semibold text-text"
        }
      >
        {stat.value}
      </span>
      <span className="sr-only">{` ${stat.label}`}</span>
    </span>
  );
}

function SideBlock({
  side,
  hud,
  label,
  race,
  mirrored,
}: {
  side: ReplaySide;
  hud: HudSide;
  label: string;
  race?: string | null;
  mirrored: boolean;
}) {
  const raceIcon = race ? resolveRaceIcon(race) : null;
  const stats = statsFor(hud);
  // Reading outward from the clock: the mirrored (left) side lays its
  // stats out in reverse so "supply" is the one nearest the clock on
  // BOTH sides.
  const ordered = mirrored ? [...stats].reverse() : stats;
  return (
    <div
      className={`flex min-w-0 items-center gap-2 sm:gap-3 ${
        mirrored ? "flex-row-reverse" : ""
      }`}
      aria-label={`${label} live stats`}
    >
      <span
        className={`flex min-w-0 items-center gap-1.5 ${
          mirrored ? "flex-row-reverse" : ""
        }`}
      >
        {raceIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={raceIcon} alt="" aria-hidden className="h-4 w-4 shrink-0" />
        ) : null}
        <span
          className="truncate text-caption font-semibold"
          style={{ color: SIDE_COLOR[side] }}
        >
          {label}
        </span>
      </span>
      <span
        className={`flex items-center gap-2 sm:gap-3 ${
          mirrored ? "flex-row-reverse" : ""
        }`}
      >
        {ordered.map((stat) => (
          <StatCell key={stat.key} stat={stat} label={label} mirrored={mirrored} />
        ))}
      </span>
    </div>
  );
}

function ReplayTopBarImpl({
  t,
  gameLength,
  hud,
  mapName,
  myName,
  oppName,
  myRace,
  oppRace,
}: {
  t: number;
  gameLength: number;
  hud: Record<ReplaySide, HudSide>;
  mapName: string;
  myName?: string | null;
  oppName?: string | null;
  myRace?: string | null;
  oppRace?: string | null;
}) {
  return (
    <div
      data-testid="replay-top-bar"
      className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border px-3 py-2"
    >
      <SideBlock
        side="me"
        hud={hud.me}
        label={sideLabel("me", myName)}
        race={myRace}
        mirrored
      />
      <div className="flex flex-col items-center leading-none">
        <span
          className="text-body-lg font-semibold tabular-nums text-text"
          aria-label={`Game clock ${formatClock(t)} of ${formatClock(gameLength)}`}
        >
          {formatClock(t)}
        </span>
        <span className="mt-0.5 max-w-[12rem] truncate text-micro text-text-dim">
          {mapName || "—"}
        </span>
      </div>
      <SideBlock
        side="opp"
        hud={hud.opp}
        label={sideLabel("opp", null, oppName)}
        race={oppRace}
        mirrored={false}
      />
    </div>
  );
}

export const ReplayTopBar = memo(ReplayTopBarImpl);
