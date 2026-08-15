"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { gatewayUnitMeta } from "@/lib/randomizer/gatewayUnits";
import type {
  GatewayUnitId,
  OpeningUnitsOutcome,
} from "@/lib/randomizer/types";
import { useReducedMotion } from "@/components/randomizer/reveals/revealShared";

export interface UnitRevealProps {
  outcome: OpeningUnitsOutcome;
  spinId: number;
  matchupLabel: string;
  buildName: string;
  onComplete?: () => void;
}

export interface AnimatedUnitPicks {
  displayed: GatewayUnitId[];
  locked: boolean[];
  allLocked: boolean;
  reducedMotion: boolean;
}

/**
 * Cycles honest candidates in each Gateway socket, then pins the pre-rolled
 * winners at the requested lock beats. Selection happens in the engine; this
 * hook only dramatizes it and cleans up every interval/timeout on re-spin.
 */
export function useAnimatedUnitPicks({
  outcome,
  spinId,
  lockTimesMs,
  durationMs,
  onComplete,
}: {
  outcome: OpeningUnitsOutcome;
  spinId: number;
  lockTimesMs: readonly number[];
  durationMs: number;
  onComplete?: () => void;
}): AnimatedUnitPicks {
  const reducedMotion = useReducedMotion();
  const poolIds = useMemo(
    () => outcome.pool.map((unit) => unit.id),
    [outcome.pool],
  );
  const initial = Array.from(
    { length: outcome.gateCount },
    (_, index) => poolIds[index % Math.max(1, poolIds.length)] ?? outcome.picks[index],
  );
  const [displayed, setDisplayed] = useState<GatewayUnitId[]>(initial);
  const [locked, setLocked] = useState<boolean[]>(
    Array(outcome.gateCount).fill(false),
  );
  const lockedRef = useRef<boolean[]>(Array(outcome.gateCount).fill(false));
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    const winners = outcome.picks.slice(0, outcome.gateCount);
    const nextInitial = Array.from(
      { length: outcome.gateCount },
      (_, index) => poolIds[index % Math.max(1, poolIds.length)] ?? winners[index],
    );
    lockedRef.current = Array(outcome.gateCount).fill(reducedMotion);
    setLocked([...lockedRef.current]);
    setDisplayed(reducedMotion ? winners : nextInitial);

    if (reducedMotion) {
      const handle = window.setTimeout(() => onCompleteRef.current?.(), 0);
      return () => window.clearTimeout(handle);
    }

    let tick = 0;
    const interval = window.setInterval(() => {
      tick += 1;
      setDisplayed((current) =>
        current.map((unit, index) => {
          if (lockedRef.current[index]) return winners[index] ?? unit;
          if (poolIds.length === 0) return winners[index] ?? unit;
          return poolIds[(tick + index * 2) % poolIds.length];
        }),
      );
    }, 105);

    const lockHandles = Array.from({ length: outcome.gateCount }, (_, index) =>
      window.setTimeout(() => {
        lockedRef.current[index] = true;
        setLocked([...lockedRef.current]);
        setDisplayed((current) =>
          current.map((unit, slot) =>
            slot === index ? winners[index] ?? unit : unit,
          ),
        );
      }, lockTimesMs[index] ?? lockTimesMs[0] ?? durationMs - 900),
    );

    const completeHandle = window.setTimeout(() => {
      lockedRef.current = Array(outcome.gateCount).fill(true);
      setLocked([...lockedRef.current]);
      setDisplayed(winners);
      onCompleteRef.current?.();
    }, durationMs);

    return () => {
      window.clearInterval(interval);
      for (const handle of lockHandles) window.clearTimeout(handle);
      window.clearTimeout(completeHandle);
    };
  }, [
    durationMs,
    lockTimesMs,
    outcome.gateCount,
    outcome.picks,
    poolIds,
    reducedMotion,
    spinId,
  ]);

  return {
    displayed,
    locked,
    allLocked: locked.length > 0 && locked.every(Boolean),
    reducedMotion,
  };
}

export function UnitRevealFrame({
  matchupLabel,
  buildName,
  modeLabel,
  resultText,
  children,
}: {
  matchupLabel: string;
  buildName: string;
  modeLabel: string;
  resultText: string | null;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: "min(650px, 96vw)",
        height: "min(370px, 72vw)",
        minHeight: 320,
        maxHeight: 370,
        overflow: "hidden",
        borderRadius: 22,
        border: "1px solid rgba(124, 140, 255, 0.42)",
        background:
          "radial-gradient(circle at 50% 42%, rgba(64,86,180,.28), transparent 42%), linear-gradient(145deg, rgba(7,10,19,.97), rgba(13,18,33,.96) 56%, rgba(8,12,23,.98))",
        boxShadow:
          "0 22px 70px rgba(0,0,0,.68), inset 0 1px 0 rgba(255,255,255,.08), 0 0 45px rgba(80,108,255,.15)",
        color: "#eef2ff",
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {resultText ?? ""}
      </span>
      <div
        style={{
          position: "absolute",
          zIndex: 6,
          top: 15,
          left: 18,
          right: 18,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: "#9aa9ff",
              fontSize: 11,
              lineHeight: 1.2,
              fontWeight: 850,
              letterSpacing: ".17em",
              textTransform: "uppercase",
            }}
          >
            {matchupLabel} · Opening protocol
          </div>
          <div
            title={buildName}
            style={{
              marginTop: 5,
              maxWidth: 430,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#d8defa",
              fontSize: 13,
              fontWeight: 650,
            }}
          >
            {buildName}
          </div>
        </div>
        <div
          style={{
            flexShrink: 0,
            padding: "5px 9px",
            borderRadius: 999,
            border: "1px solid rgba(91,211,255,.35)",
            background: "rgba(41,117,165,.14)",
            color: "#7ee7ff",
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: ".14em",
            textTransform: "uppercase",
          }}
        >
          {modeLabel}
        </div>
      </div>
      {children}
    </div>
  );
}

export function UnitPortrait({
  id,
  size = 64,
  dim = false,
}: {
  id: GatewayUnitId;
  size?: number;
  dim?: boolean;
}) {
  const unit = gatewayUnitMeta(id);
  return (
    // Plain local PNG keeps OBS rendering deterministic and bypasses the
    // optimization route/network hop used by next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={unit.iconPath}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        opacity: dim ? 0.48 : 1,
        filter: dim
          ? "saturate(.55) brightness(.72)"
          : "drop-shadow(0 7px 12px rgba(0,0,0,.48))",
      }}
    />
  );
}

export function UnitOddsStrip({
  outcome,
  hidden,
}: {
  outcome: OpeningUnitsOutcome;
  hidden?: boolean;
}) {
  return (
    <div
      aria-hidden={hidden || undefined}
      style={{
        position: "absolute",
        zIndex: 5,
        left: 16,
        right: 16,
        bottom: 13,
        display: "grid",
        gridTemplateColumns: `repeat(${outcome.pool.length}, minmax(0, 1fr))`,
        gap: 6,
        opacity: hidden ? 0 : 1,
        transform: hidden ? "translateY(8px)" : "none",
        transition: "opacity 240ms ease, transform 240ms ease",
      }}
    >
      {outcome.pool.map((entry, index) => {
        const unit = gatewayUnitMeta(entry.id);
        const pct = Math.round((outcome.probabilities[index] ?? 0) * 100);
        return (
          <div
            key={entry.id}
            style={{
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
              padding: "5px 6px",
              borderRadius: 8,
              border: "1px solid rgba(143,158,225,.2)",
              background: "rgba(6,9,17,.62)",
            }}
          >
            <UnitPortrait id={entry.id} size={21} />
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "#aeb8dc",
                fontSize: 10,
                fontWeight: 700,
                whiteSpace: "nowrap",
              }}
            >
              {unit.name}
            </span>
            <span
              style={{
                flexShrink: 0,
                color: "#72dfff",
                fontSize: 10,
                fontWeight: 850,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function UnitResultCard({
  outcome,
  buildName,
  show,
}: {
  outcome: OpeningUnitsOutcome;
  buildName: string;
  show: boolean;
}) {
  return (
    <div
      aria-hidden={!show}
      style={{
        position: "absolute",
        zIndex: 30,
        left: "50%",
        top: "51%",
        width: "min(470px, calc(100% - 24px))",
        boxSizing: "border-box",
        padding: "14px 12px 16px",
        borderRadius: 18,
        border: "1px solid rgba(245,201,92,.82)",
        background:
          "linear-gradient(145deg, rgba(8,11,21,.98), rgba(19,25,44,.98))",
        boxShadow:
          "0 20px 52px rgba(0,0,0,.72), 0 0 38px rgba(245,201,92,.2), inset 0 1px 0 rgba(255,255,255,.1)",
        opacity: show ? 1 : 0,
        transform: `translate(-50%, -50%) scale(${show ? 1 : 0.78})`,
        transition:
          "opacity 280ms ease, transform 420ms cubic-bezier(.2,1.45,.35,1)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          textAlign: "center",
          color: "#f7d87d",
          fontSize: 10,
          fontWeight: 900,
          letterSpacing: ".18em",
          textTransform: "uppercase",
        }}
      >
        {outcome.gateCount === 2 ? "Opening pair locked" : "First unit locked"}
      </div>
      <div
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns:
            outcome.gateCount === 2
              ? "repeat(2, minmax(0, 1fr))"
              : "minmax(0, 188px)",
          justifyContent: "center",
          gap: outcome.gateCount === 2 ? 8 : 0,
        }}
      >
        {outcome.picks.map((id, index) => {
          const unit = gatewayUnitMeta(id);
          const poolIndex = outcome.pool.findIndex((entry) => entry.id === id);
          const probability = outcome.probabilities[poolIndex] ?? 0;
          return (
            <div
              key={`${index}-${id}`}
              style={{
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px clamp(5px, 1.5vw, 10px)",
                borderRadius: 12,
                border: "1px solid rgba(126,231,255,.28)",
                background: "rgba(72,100,184,.13)",
              }}
            >
              <UnitPortrait id={id} size={46} />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    color: "#8193cb",
                    fontSize: 9,
                    fontWeight: 850,
                    letterSpacing: ".13em",
                    textTransform: "uppercase",
                  }}
                >
                  Gate {index + 1}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    color: "#f3f6ff",
                    fontSize: "clamp(13px, 4vw, 18px)",
                    fontWeight: 850,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {unit.name}
                </div>
                <div
                  style={{
                    marginTop: 1,
                    color: "#76dff6",
                    fontSize: 10,
                    fontWeight: 750,
                  }}
                >
                  {(probability * 100).toFixed(1)}% roll
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div
        title={buildName}
        style={{
          marginTop: 9,
          overflow: "hidden",
          textAlign: "center",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "#8f99bd",
          fontSize: 10,
        }}
      >
        Queued for {buildName}
      </div>
    </div>
  );
}

export function resultAnnouncement(outcome: OpeningUnitsOutcome): string {
  const names = outcome.picks.map((id) => gatewayUnitMeta(id).name);
  return outcome.gateCount === 2
    ? `Opening pair selected: Gate 1 ${names[0]}, Gate 2 ${names[1]}.`
    : `First unit selected: ${names[0]}.`;
}

export function UnitRevealKeyframes() {
  return (
    <style>{`
      @keyframes rdz-unit-rotate { to { transform: rotate(360deg); } }
      @keyframes rdz-unit-reverse { to { transform: rotate(-360deg); } }
      @keyframes rdz-unit-scan {
        0% { transform: translateX(-135%); opacity: 0; }
        12%, 82% { opacity: .9; }
        100% { transform: translateX(480%); opacity: 0; }
      }
      @keyframes rdz-unit-beam {
        0%, 100% { opacity: .28; filter: brightness(.8); }
        50% { opacity: 1; filter: brightness(1.7); }
      }
      @keyframes rdz-unit-pop {
        0% { transform: scale(.55); opacity: 0; filter: brightness(2.4); }
        68% { transform: scale(1.14); opacity: 1; }
        100% { transform: scale(1); opacity: 1; filter: brightness(1); }
      }
      @keyframes rdz-unit-flow {
        0% { transform: translateX(-110%); opacity: 0; }
        18%, 75% { opacity: 1; }
        100% { transform: translateX(300%); opacity: 0; }
      }
      @keyframes rdz-unit-float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-6px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .rdz-unit-motion { animation: none !important; transition: none !important; }
      }
    `}</style>
  );
}
