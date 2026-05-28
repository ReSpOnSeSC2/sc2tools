"use client";

/**
 * Shared helpers for the icon-sprite reveal animations (fighter brawl,
 * horse race, sumo, asteroid lock-on, hungry swarm, claw machine).
 *
 * Each build is represented by a real SC2 unit sprite. A build whose
 * name names a unit keeps that unit; the rest are handed a distinct
 * unit of the player's race so every sprite on screen looks different
 * (see `assignPoolSprites`). The winner is always decided up front by
 * the engine — the physics here is rigged so the predetermined winner
 * survives, so the visual can never disagree with the recorded pick.
 */
import { useEffect, useRef, useState } from "react";
import {
  getIconPath,
  resolveRaceIcon,
  resolveStrategyIcons,
} from "@/lib/sc2-icons";
import { coerceRace, type Race } from "@/lib/race";
import { RaceIcon } from "@/components/overlay/WidgetShell";
import type { RandomizerBuild } from "@/lib/randomizer/types";

/**
 * Per-race combat-unit rosters, roughly tech-tier ordered. Used to hand
 * each build a distinct sprite of the race the streamer is playing.
 */
const RACE_UNITS: Record<Race, ReadonlyArray<string>> = {
  Protoss: [
    "zealot", "stalker", "adept", "sentry", "immortal", "colossus",
    "archon", "phoenix", "voidray", "oracle", "carrier", "tempest",
    "disruptor", "darktemplar", "hightemplar", "mothership", "observer",
    "warpprism", "probe",
  ],
  Terran: [
    "marine", "marauder", "reaper", "hellion", "hellbat", "widowmine",
    "cyclone", "siegetank", "thor", "viking", "medivac", "liberator",
    "banshee", "raven", "battlecruiser", "ghost", "scv",
  ],
  Zerg: [
    "zergling", "baneling", "roach", "ravager", "hydralisk", "lurker",
    "mutalisk", "corruptor", "broodlord", "infestor", "viper",
    "swarmhost", "ultralisk", "queen", "overseer", "overlord", "drone",
  ],
  Random: ["probe", "marine", "zergling", "zealot", "scv", "drone"],
};

/**
 * Resolve a build to a single representative unit sprite. Prefers the
 * unit named in the build, falling back to the player's race's
 * signature unit. The race glyph is a last resort that should never
 * trigger for a real race.
 */
export function spriteFor(build: RandomizerBuild): string | null {
  const unit = resolveStrategyIcons(build.name, 6).find((u) =>
    u.includes("/units/"),
  );
  if (unit) return unit;
  const race = coerceRace(build.race);
  const fallback = getIconPath(RACE_UNITS[race][0], "unit");
  return fallback ?? resolveRaceIcon(build.race);
}

/**
 * Assign every build in a pool a DISTINCT unit sprite so the reveal
 * shows a different icon per build:
 *   1. builds that name a specific unit keep it,
 *   2. the rest get the next unused unit of the player's race,
 *   3. only if a matchup has more builds than the race has unit icons
 *      do we spill over to that build's non-unit strategy icon (then a
 *      repeated race unit) — matching "race units by default unless
 *      there are too many for the unit icons available".
 */
export function assignPoolSprites(
  pool: ReadonlyArray<RandomizerBuild>,
): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();

  for (const b of pool) {
    const unit = resolveStrategyIcons(b.name, 6).find((u) =>
      u.includes("/units/"),
    );
    if (unit && !used.has(unit)) {
      out.set(b.id, unit);
      used.add(unit);
    }
  }

  for (const b of pool) {
    if (out.has(b.id)) continue;
    const race = coerceRace(b.race);
    let pick: string | null = null;
    for (const name of RACE_UNITS[race]) {
      const url = getIconPath(name, "unit");
      if (url && !used.has(url)) { pick = url; break; }
    }
    if (!pick) {
      // Too many builds for the race's unit icons — fall back to the
      // build's own (possibly non-unit) strategy icon, else any race
      // unit, else the race glyph.
      const any = resolveStrategyIcons(b.name, 6).find((u) => !used.has(u));
      pick =
        any ??
        getIconPath(RACE_UNITS[race][0], "unit") ??
        resolveRaceIcon(b.race);
    }
    if (pick) {
      out.set(b.id, pick);
      used.add(pick);
    }
  }

  return out;
}

/** A build sprite as an <img>, with a race-glyph fallback. */
export function BuildSprite({
  build,
  size = 48,
  src,
}: {
  build: RandomizerBuild;
  size?: number;
  src?: string | null;
}) {
  const [errored, setErrored] = useState(false);
  const resolved = src === undefined ? spriteFor(build) : src;
  if (!resolved || errored) {
    return <RaceIcon race={build.race} size={size} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolved}
      alt=""
      width={size}
      height={size}
      loading="eager"
      decoding="sync"
      draggable={false}
      onError={() => setErrored(true)}
      style={{ width: size, height: size, objectFit: "contain", display: "block" }}
    />
  );
}

/**
 * Legend mapping each sprite to its build name, so viewers can tell
 * which icon is which during the chaos. Rendered below an arena; the
 * active contestant can be highlighted as the reveal narrows down.
 */
export function SpriteLegend({
  pool,
  sprites,
  highlightId,
  eliminated,
}: {
  pool: ReadonlyArray<RandomizerBuild>;
  sprites: Map<string, string>;
  highlightId?: string | null;
  eliminated?: Set<string>;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        justifyContent: "center",
        maxWidth: 560,
        marginTop: 10,
      }}
    >
      {pool.map((b) => {
        const out = eliminated?.has(b.id) ?? false;
        const on = highlightId === b.id;
        return (
          <span
            key={b.id}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "3px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1.1,
              color: out ? "#6b7280" : "#cdd2db",
              background: on ? "rgba(230,180,80,0.16)" : "rgba(255,255,255,0.05)",
              border: `1px solid ${on ? "#e6b450" : "rgba(255,255,255,0.10)"}`,
              textDecoration: out ? "line-through" : "none",
              opacity: out ? 0.6 : 1,
            }}
          >
            <BuildSprite build={b} src={sprites.get(b.id) ?? null} size={16} />
            <span
              style={{
                maxWidth: 150,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {b.name}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * requestAnimationFrame loop. Calls `cb(dtMs, elapsedMs)` each frame
 * while `active`. Auto-stops + cleans up on unmount or when active
 * flips false. `spinId` restarts the clock.
 */
export function useRaf(
  active: boolean,
  spinId: number,
  cb: (dtMs: number, elapsedMs: number) => void,
): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const start = last;
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      cbRef.current(dt, now - start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, spinId]);
}

/**
 * Elapsed-time driver for motion reveals that settle on a fixed
 * duration (race, swarm, claw). Returns the running `elapsed` ms and a
 * `settled` flag, firing `onComplete` once. Reduced motion settles
 * immediately.
 */
export function useElapsedReveal(
  spinId: number,
  durationMs: number,
  reducedMotion: boolean,
  onComplete?: () => void,
): { elapsed: number; settled: boolean } {
  const [elapsed, setElapsed] = useState(0);
  const [settled, setSettled] = useState(false);
  const doneRef = useRef(false);

  useEffect(() => {
    setElapsed(0);
    setSettled(false);
    doneRef.current = false;
    if (reducedMotion) {
      doneRef.current = true;
      setElapsed(durationMs);
      setSettled(true);
      onComplete?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, reducedMotion, durationMs]);

  useRaf(!reducedMotion && !settled, spinId, (_dt, el) => {
    setElapsed(el);
    if (el >= durationMs && !doneRef.current) {
      doneRef.current = true;
      setSettled(true);
      onComplete?.();
    }
  });

  return { elapsed, settled };
}

/** Deterministic Fisher-Yates shuffle seeded by `seed`. */
export function seededShuffle<T>(list: ReadonlyArray<T>, seed: number): T[] {
  const arr = [...list];
  let s = seed | 0;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Schedule the losers to be eliminated one-by-one across `durationMs`,
 * leaving the winner last. Returns the running eliminated set plus a
 * `settled` flag once the winner stands alone. Honours reduced motion
 * by settling instantly.
 */
export function useEliminationSchedule(
  spinId: number,
  loserIdsInOrder: string[],
  durationMs: number,
  reducedMotion: boolean,
  onComplete?: () => void,
): { eliminated: Set<string>; settled: boolean; nextOutId: string | null } {
  const [eliminated, setEliminated] = useState<Set<string>>(() => new Set());
  const [settled, setSettled] = useState(false);
  const [nextOutId, setNextOutId] = useState<string | null>(
    loserIdsInOrder[0] ?? null,
  );

  useEffect(() => {
    setEliminated(new Set());
    setSettled(false);
    setNextOutId(loserIdsInOrder[0] ?? null);

    if (reducedMotion || loserIdsInOrder.length === 0) {
      setEliminated(new Set(loserIdsInOrder));
      setSettled(true);
      setNextOutId(null);
      onComplete?.();
      return;
    }

    const n = loserIdsInOrder.length;
    // Leave a short victory beat after the last elimination.
    const step = durationMs / (n + 1);
    const handles: number[] = [];
    loserIdsInOrder.forEach((id, i) => {
      handles.push(
        window.setTimeout(() => {
          setEliminated((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          setNextOutId(loserIdsInOrder[i + 1] ?? null);
        }, step * (i + 1)),
      );
    });
    handles.push(
      window.setTimeout(() => {
        setSettled(true);
        onComplete?.();
      }, durationMs),
    );
    return () => {
      for (const h of handles) window.clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, reducedMotion, durationMs, loserIdsInOrder.length]);

  return { eliminated, settled, nextOutId };
}
