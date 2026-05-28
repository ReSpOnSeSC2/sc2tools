"use client";

/**
 * Shared helpers for the icon-sprite reveal animations (fighter brawl,
 * horse race, sumo, asteroid lock-on, hungry swarm, claw machine).
 *
 * Each build is represented by a real SC2 unit/building sprite resolved
 * from its name via `resolveStrategyIcons`, falling back to the race
 * glyph. The winner is always decided up front by the engine — the
 * physics here is rigged so the predetermined winner survives, so the
 * visual can never disagree with the recorded pick.
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

/** Signature combat unit per race — the unit-only fallback sprite. */
const RACE_UNIT: Record<Race, string> = {
  Protoss: "zealot",
  Terran: "marine",
  Zerg: "zergling",
  Random: "probe",
};

/**
 * Resolve a build to a single representative sprite URL. These reveals
 * are unit-only by design (a marine racing reads better than a barracks
 * racing), so we take the build's first matching unit icon and, only
 * when the build name resolves to no unit at all, fall back to the
 * race's signature unit. The race glyph is a last resort that should
 * never trigger for a real race.
 */
export function spriteFor(build: RandomizerBuild): string | null {
  const unit = resolveStrategyIcons(build.name, 6).find((u) =>
    u.includes("/units/"),
  );
  if (unit) return unit;
  const fallback = getIconPath(RACE_UNIT[coerceRace(build.race)], "unit");
  return fallback ?? resolveRaceIcon(build.race);
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
