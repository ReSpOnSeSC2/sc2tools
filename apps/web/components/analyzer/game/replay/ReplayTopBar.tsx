"use client";

/**
 * ReplayTopBar — the mirrored scoreboard across the top of the stage.
 *
 * One row: you on the left, the opponent on the right, the game clock
 * in the middle. Reading OUTWARD from the clock each side shows supply,
 * workers, minerals, gas, army value and kills, so the two sides are
 * directly comparable at a glance.
 *
 * Every stat is a VALUE over a LABEL. The old row was glyph + number
 * with the meaning hidden in a ``title``, which made the bar unreadable
 * without hovering each cell one at a time — and the glyphs (▲ ⛏ ◆ ●
 * ⚔ ☠) rendered as a different soup on every platform. The labels are
 * always visible, and the ``title`` is kept verbatim because it is the
 * hover affordance and the hook the stage's tests key off.
 *
 * The two names are the ONLY coloured text in the bar, which is what
 * makes "cyan is me, red is them" learnable in one glance and keeps it
 * consistent with the canvas and both rails.
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
  /** The accessible/hover wording — "minerals banked", not "minerals". */
  label: string;
  /** The always-visible caption under the number. Short by necessity:
   *  six of these share the half-bar left of the clock. */
  short: string;
  value: string;
  /** Muted stats sit behind the ones that decide games. */
  dim?: boolean;
  /** Breakpoint below which the cell is dropped. Twelve stat cells,
   *  two names and a clock do not fit on a laptop half-screen, let
   *  alone a phone, and a truncated scoreboard is worse than a short
   *  one — so the bar sheds its least decisive numbers first and
   *  always keeps supply and workers. */
  from?: "sm" | "lg" | "xl";
}

function statsFor(side: HudSide): StatDef[] {
  const out: StatDef[] = [
    {
      key: "supply",
      label: "supply",
      short: "supply",
      value: `${Math.round(side.supplyUsed)}/${side.supplyCap || "—"}`,
    },
    {
      key: "workers",
      label: "workers",
      short: "workers",
      value: `${Math.round(side.workers)}`,
    },
  ];
  if (side.minerals !== null) {
    out.push({
      key: "minerals",
      label: "minerals banked",
      short: "min",
      value: `${Math.round(side.minerals)}`,
      from: "lg",
    });
  }
  if (side.gas !== null) {
    out.push({
      key: "gas",
      label: "gas banked",
      short: "gas",
      value: `${Math.round(side.gas)}`,
      from: "lg",
    });
  }
  out.push(
    {
      key: "army",
      label: "army value",
      short: "army",
      value: `${Math.round(side.armyValue)}`,
      from: "sm",
    },
    {
      key: "kills",
      label: "kills",
      short: "kills",
      value: `${side.kills}`,
      dim: true,
      from: "xl",
    },
  );
  return out;
}

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
      /* Static strings, never interpolated: Tailwind's scanner reads
         source text, so ``hidden ${bp}:flex`` would generate nothing. */
      className={`min-w-0 flex-col whitespace-nowrap tabular-nums ${
        stat.from === "sm"
          ? "hidden sm:flex"
          : stat.from === "lg"
            ? "hidden lg:flex"
            : stat.from === "xl"
              ? "hidden xl:flex"
              : "flex"
      } ${mirrored ? "items-end" : "items-start"}`}
      title={`${label} — ${stat.label}`}
    >
      <span
        className={`text-caption font-semibold leading-tight ${
          stat.dim ? "text-text-muted" : "text-text"
        }`}
      >
        {stat.value}
      </span>
      <span
        aria-hidden
        className="text-[0.625rem] font-medium uppercase leading-tight tracking-[0.08em] text-text-dim"
      >
        {stat.short}
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
      className={`flex min-w-0 items-center gap-3 sm:gap-4 ${
        mirrored ? "flex-row-reverse" : ""
      }`}
      aria-label={`${label} live stats`}
    >
      <span
        className={`flex min-w-0 items-center gap-2 ${
          mirrored ? "flex-row-reverse" : ""
        }`}
      >
        {raceIcon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={raceIcon} alt="" aria-hidden className="h-5 w-5 shrink-0" />
        ) : (
          <span
            aria-hidden
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: SIDE_COLOR[side] }}
          />
        )}
        <span
          className="min-w-[2.5rem] truncate text-body font-semibold leading-tight tracking-tight"
          style={{ color: SIDE_COLOR[side] }}
        >
          {label}
        </span>
      </span>
      <span
        className={`flex min-w-0 items-start gap-2.5 overflow-hidden sm:gap-4 ${
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
      className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border bg-bg-surface/60 px-3 py-2.5"
    >
      <SideBlock
        side="me"
        hud={hud.me}
        label={sideLabel("me", myName)}
        race={myRace}
        mirrored
      />
      <div className="flex flex-col items-center px-1 leading-none">
        <span
          className="font-display text-h3 font-bold tabular-nums leading-none text-text"
          aria-label={`Game clock ${formatClock(t)} of ${formatClock(gameLength)}`}
        >
          {formatClock(t)}
        </span>
        <span className="mt-1 max-w-[12rem] truncate text-micro font-medium text-text-dim">
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
