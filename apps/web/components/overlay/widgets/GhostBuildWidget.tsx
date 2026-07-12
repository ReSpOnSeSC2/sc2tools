"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveGameEnvelope, LiveGamePayload } from "../types";
import { WidgetShell, WidgetHeader, Dim } from "../WidgetShell";
import {
  decodeGhostBuildConfig,
  decodeGhostTarget,
  ghostMatchupKey,
  selectGhostTarget,
  type GhostStep,
  type GhostTarget,
} from "@/lib/ghostBuild";
import { resolveGhostLiveRaces } from "@/lib/ghostLiveMatchup";

/**
 * GhostBuildWidget — the Ghost Build practice coach, a persistent HUD.
 *
 * The nine-matchup build config travels in this Browser Source's own URL as the
 * ``?ghost=`` param (versioned base64url, hostile-input safe — see
 * lib/ghostBuild.ts). Zero server state: the widget decodes the param
 * once and everything else derives from the live envelope.
 *
 * Three render states:
 *   1. No target armed — renders nothing (transparent scene). A Test
 *      fire (``live.isTest``) shows a hint card instead so the streamer
 *      can still position the source before arming.
 *   2. Target armed, no active game — compact "ARMED: <name>" idle
 *      card so the streamer knows tonight's homework is loaded.
 *   3. Target armed + active match — the coach: previous step (done,
 *      dim), current step, next two steps with target times, and a
 *      drift chip once the live clock passes the current step's target
 *      time (green ≤ 5 s behind, amber ≤ 15 s, red > 15 s).
 *
 * LIVE CLOCK: the agent's envelope carries ``displayTime`` (the SC2
 * client's in-game clock, seconds) on its ~1 Hz ticks. The widget
 * anchors that value to the wall clock on every envelope and
 * interpolates locally at 1 Hz between ticks, so the coach advances
 * smoothly even when a tick is dropped. When an envelope has no
 * ``displayTime`` (older agents), the clock falls back to wall-time
 * elapsed since the first ``match_started`` envelope observed for this
 * gameKey — documented drift: it misses the loading-screen offset, so
 * timings read a touch early, which is the safe direction for a coach.
 *
 * OBS-safe: WidgetShell chrome + theme vars, fixed row slots (the
 * prev/current/next lines always render, empty ones as placeholders)
 * and tabular numerals so the 1 Hz clock tick never reflows layout.
 */
export function GhostBuildWidget({
  live,
  liveGame,
  ghostParam = null,
}: {
  live: LiveGamePayload | null;
  liveGame: LiveGameEnvelope | null;
  /** Raw ``?ghost=`` search param from the widget page. Decoded once,
   *  strict validation — malformed values act like "not armed". */
  ghostParam?: string | null;
}) {
  const config = useMemo(() => decodeGhostBuildConfig(ghostParam), [ghostParam]);
  // Keep old v1 URLs recognizable, but never fan their one build across all
  // matchups. The user gets a migration prompt instead of incorrect coaching.
  const legacyTarget = useMemo(
    () => (config ? null : decodeGhostTarget(ghostParam)),
    [config, ghostParam],
  );
  const races = useMemo(() => resolveGhostLiveRaces(liveGame), [liveGame]);
  const clockSec = useLiveGameClock(liveGame);
  const phase = liveGame?.phase ?? null;
  const matchActive =
    phase === "match_loading"
    || phase === "match_started"
    || phase === "match_in_progress";
  const activeIdentity = matchActive
    ? liveGame?.gameKey ?? "__ghost_unkeyed_game__"
    : null;
  const [randomBlockedKey, setRandomBlockedKey] = useState<string | null>(null);

  // Once the loading screen says Random, keep the coach blocked for this
  // gameKey even if SC2 later replaces the race with the revealed faction.
  // Agent 0.14.0 also latches this server-side, so a Browser Source refresh
  // preserves the same guarantee; this client latch protects older agents.
  useEffect(() => {
    if (!activeIdentity) {
      setRandomBlockedKey(null);
      return;
    }
    if (races.opponentIsRandom) {
      setRandomBlockedKey(activeIdentity);
      return;
    }
    if (randomBlockedKey && randomBlockedKey !== activeIdentity) {
      setRandomBlockedKey(null);
    }
  }, [activeIdentity, races.opponentIsRandom, randomBlockedKey]);

  const randomBlocked = Boolean(
    matchActive
    && activeIdentity
    && (races.opponentIsRandom || randomBlockedKey === activeIdentity),
  );

  if (!config) {
    if (legacyTarget) {
      return (
        <GhostStatusCard status="update URL" title="Matchup setup required">
          This source still has one legacy build. Choose builds for the nine
          matchups in Settings → Overlay, then copy the Ghost URL again.
        </GhostStatusCard>
      );
    }
    // Test fires get a hint card so "Test" in Settings shows WHERE the
    // widget will sit; a real scene without a target stays transparent.
    if (live?.isTest) {
      return (
        <WidgetShell slot="bottom-left" accent="cyan" visible width={320}>
          <WidgetHeader>
            <span>Ghost Build</span>
            <Dim>not armed</Dim>
          </WidgetHeader>
          <p style={{ margin: "6px 0 0", fontSize: 13, opacity: 0.8 }}>
            Arm a build from a game page&apos;s build log, then
            re-copy this widget URL from Settings → Overlay.
          </p>
        </WidgetShell>
      );
    }
    return null;
  }

  const configuredCount = Object.keys(config.slots).length;

  if (!matchActive || clockSec === null) {
    // Between games — compact idle card summarises the full loadout.
    return (
      <WidgetShell slot="bottom-left" accent="cyan" visible width={320}>
        <WidgetHeader>
          <span>Ghost Build</span>
          <Dim>armed</Dim>
        </WidgetHeader>
        <p style={{ margin: "6px 0 0", fontSize: 14, fontWeight: 700 }}>
          {configuredCount} of 9 matchups ready
        </p>
        <p style={{ margin: "2px 0 0", fontSize: 12, opacity: 0.6 }}>
          Waiting for the loading-screen races
        </p>
      </WidgetShell>
    );
  }

  if (randomBlocked) {
    return (
      <GhostStatusCard status="paused" title="No build order vs Random players">
        Ghost stays off for this entire game, even after the opponent&apos;s race
        is revealed.
      </GhostStatusCard>
    );
  }

  if (races.ownRaceIsRandom) {
    return (
      <GhostStatusCard status="paused" title="No matchup build while playing Random">
        Choose Terran, Protoss, or Zerg to use one of the nine configured slots.
      </GhostStatusCard>
    );
  }

  const matchup = ghostMatchupKey(races.ownRace, races.opponentRace);
  if (!matchup) {
    return (
      <GhostStatusCard status="waiting" title="Waiting for matchup">
        Ghost will select a build after both concrete races are available.
      </GhostStatusCard>
    );
  }

  const target = selectGhostTarget(config, races.ownRace, races.opponentRace);
  if (!target) {
    return (
      <GhostStatusCard status={matchup} title={`No build order configured for ${matchup}`}>
        Save a completed-game build for this matchup, assign it in Settings →
        Overlay, and copy the Ghost URL again.
      </GhostStatusCard>
    );
  }

  return <GhostCoach target={target} clockSec={clockSec} matchup={matchup} />;
}

function GhostStatusCard({
  status,
  title,
  children,
}: {
  status: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <WidgetShell slot="bottom-left" accent="cyan" visible width={340}>
      <WidgetHeader>
        <span>Ghost Build</span>
        <Dim>{status}</Dim>
      </WidgetHeader>
      <p style={{ margin: "7px 0 0", fontSize: 14, fontWeight: 700 }}>
        {title}
      </p>
      <p style={{ margin: "3px 0 0", fontSize: 12, opacity: 0.68 }}>
        {children}
      </p>
    </WidgetShell>
  );
}

/* ------------------------------------------------------------------ */
/* Coach view                                                          */
/* ------------------------------------------------------------------ */

const DRIFT_GREEN_MAX_SEC = 5;
const DRIFT_AMBER_MAX_SEC = 15;

function GhostCoach({
  target,
  clockSec,
  matchup,
}: {
  target: GhostTarget;
  clockSec: number;
  matchup: string;
}) {
  const steps = target.steps;
  // Number of steps whose target time has passed. The step whose time
  // most recently passed is "current" (the one the player should be
  // executing right now); earlier ones roll into the dim "done" slot.
  let passed = 0;
  while (passed < steps.length && steps[passed].t <= clockSec) passed += 1;

  const currentIndex = passed === 0 ? 0 : passed - 1;
  const current = steps[currentIndex];
  const prev = currentIndex > 0 ? steps[currentIndex - 1] : null;
  const next1 = steps[currentIndex + 1] ?? null;
  const next2 = steps[currentIndex + 2] ?? null;
  const complete = passed >= steps.length;

  // Drift only exists once the clock has passed the current step's
  // target time — before the first step there's nothing to be late on.
  const drift = passed === 0 ? null : Math.max(0, clockSec - current.t);
  const driftColor =
    drift === null
      ? undefined
      : drift <= DRIFT_GREEN_MAX_SEC
        ? "#3ec07a"
        : drift <= DRIFT_AMBER_MAX_SEC
          ? "#e6b450"
          : "#ff6b6b";
  const driftBg =
    drift === null
      ? undefined
      : drift <= DRIFT_GREEN_MAX_SEC
        ? "rgba(62,192,122,0.18)"
        : drift <= DRIFT_AMBER_MAX_SEC
          ? "rgba(230,180,80,0.18)"
          : "rgba(255,107,107,0.18)";

  return (
    <WidgetShell slot="bottom-left" accent="cyan" visible width={340}>
      <WidgetHeader>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 14,
            opacity: 0.85,
          }}
          title={target.name}
        >
          {target.name}
        </span>
        <span
          style={{
            fontSize: 13,
            fontVariantNumeric: "tabular-nums",
            opacity: 0.7,
            flexShrink: 0,
          }}
        >
          {matchup} · {formatClock(clockSec)}
        </span>
      </WidgetHeader>

      <div style={{ marginTop: 8, fontVariantNumeric: "tabular-nums" }}>
        {/* Done slot — the previous step, dim. Fixed-height placeholder
            before anything is done so the panel never resizes. */}
        <StepRow step={prev} tone="done" />

        {/* Current step + drift chip. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minHeight: 26,
          }}
        >
          <span
            style={{
              width: 42,
              flexShrink: 0,
              fontSize: 13,
              opacity: 0.75,
            }}
          >
            {formatClock(current.t)}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 16,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={current.name}
          >
            {current.supply !== null ? `${current.supply} ` : ""}
            {spaceName(current.name)}
          </span>
          <span
            style={{
              flexShrink: 0,
              minWidth: 48,
              textAlign: "center",
              fontSize: 12,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 4,
              background: driftBg ?? "transparent",
              color: driftColor ?? "rgba(230,232,238,0.5)",
            }}
          >
            {drift === null
              ? `in ${Math.max(0, current.t - clockSec)}s`
              : `+${drift}s`}
          </span>
        </div>

        {/* Next two steps — the "what's coming" strip. */}
        <StepRow step={complete ? null : next1} tone="next" />
        <StepRow step={complete ? null : next2} tone="next" />
        {complete ? (
          <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.6 }}>
            Target complete — free play from here.
          </p>
        ) : null}
      </div>
    </WidgetShell>
  );
}

function StepRow({
  step,
  tone,
}: {
  step: GhostStep | null;
  tone: "done" | "next";
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 20,
        opacity: step ? (tone === "done" ? 0.4 : 0.75) : 0,
      }}
      aria-hidden={step ? undefined : true}
    >
      <span style={{ width: 42, flexShrink: 0, fontSize: 12 }}>
        {step ? formatClock(step.t) : ""}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textDecoration: tone === "done" ? "line-through" : undefined,
        }}
        title={step ? step.name : undefined}
      >
        {step
          ? `${step.supply !== null ? `${step.supply} ` : ""}${spaceName(step.name)}`
          : "—"}
      </span>
    </div>
  );
}

/** "SpawningPool" → "Spawning Pool" for readable step labels. Local,
 * tiny — lib/build-events' humanizeBuildName drags icon tables along. */
function spaceName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Live clock                                                          */
/* ------------------------------------------------------------------ */

/**
 * Derive the in-game clock (whole seconds) from the agent's live
 * envelope. Returns null when no match is active (idle / menu / ended /
 * agent offline), which is the widget's "between games" signal.
 *
 * Sources, in priority order (documented in the widget header):
 *   1. ``displayTime`` — SC2's own in-game clock, anchored to the wall
 *      clock at each envelope and interpolated locally at 1 Hz.
 *   2. Wall-time elapsed since the first ``match_started`` /
 *      ``match_in_progress`` envelope observed for this gameKey (older
 *      agents that don't report ``displayTime``).
 *   ``match_loading`` reports 0 — the coach shows the opening step
 *   while the map loads.
 */
function useLiveGameClock(liveGame: LiveGameEnvelope | null): number | null {
  const anchorRef = useRef<{ display: number; wallMs: number } | null>(null);
  const startWallRef = useRef<number | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const [clock, setClock] = useState<number | null>(null);

  const phase = liveGame?.phase ?? null;
  const active = phase === "match_started" || phase === "match_in_progress";
  const loading = phase === "match_loading";
  const gameKey =
    liveGame && typeof liveGame.gameKey === "string" ? liveGame.gameKey : null;

  useEffect(() => {
    // New match identity — drop the previous game's anchors so a
    // back-to-back queue can't inherit a stale clock.
    if (gameKey !== lastKeyRef.current) {
      lastKeyRef.current = gameKey;
      anchorRef.current = null;
      startWallRef.current = null;
    }
    if (!liveGame || (!active && !loading)) {
      anchorRef.current = null;
      startWallRef.current = null;
      return;
    }
    if (loading) {
      anchorRef.current = null;
      startWallRef.current = null;
      return;
    }
    if (
      typeof liveGame.displayTime === "number"
      && Number.isFinite(liveGame.displayTime)
      && liveGame.displayTime >= 0
    ) {
      anchorRef.current = {
        display: liveGame.displayTime,
        wallMs: Date.now(),
      };
    } else if (startWallRef.current === null) {
      startWallRef.current = Date.now();
    }
  }, [liveGame, active, loading, gameKey]);

  useEffect(() => {
    if (loading) {
      setClock(0);
      return;
    }
    if (!active) {
      setClock(null);
      return;
    }
    const compute = (): number => {
      const anchor = anchorRef.current;
      if (anchor) {
        return Math.max(
          0,
          Math.floor(anchor.display + (Date.now() - anchor.wallMs) / 1000),
        );
      }
      const start = startWallRef.current;
      if (start !== null) {
        return Math.max(0, Math.floor((Date.now() - start) / 1000));
      }
      return 0;
    };
    setClock(compute());
    // 1 Hz local tick between envelope ticks. setState with the same
    // integer is a React no-op, so a duplicate second costs nothing.
    const id = window.setInterval(() => setClock(compute()), 1000);
    return () => window.clearInterval(id);
  }, [active, loading, gameKey]);

  return clock;
}
