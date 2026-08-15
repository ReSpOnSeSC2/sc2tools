"use client";

import { gatewayUnitMeta } from "@/lib/randomizer/gatewayUnits";
import { useRevealSound } from "@/components/randomizer/reveals/revealSound";
import {
  resultAnnouncement,
  UnitPortrait,
  UnitResultCard,
  UnitRevealFrame,
  type UnitRevealProps,
  useAnimatedUnitPicks,
} from "./unitRevealShared";

export const HOLO_DRAFT_DURATION_MS = 4_900;
const LOCK_TIMES = [2_800, 3_550] as const;

/** A compact command-console draft: scan the deck, then stamp Gate sockets. */
export function HoloDraftReveal(props: UnitRevealProps) {
  const animation = useAnimatedUnitPicks({
    outcome: props.outcome,
    spinId: props.spinId,
    lockTimesMs: LOCK_TIMES,
    durationMs: HOLO_DRAFT_DURATION_MS,
    onComplete: props.onComplete,
  });
  useRevealSound({
    style: "slot",
    spinId: props.spinId,
    durationMs: HOLO_DRAFT_DURATION_MS,
    reducedMotion: animation.reducedMotion,
  });

  const activeGate = animation.locked.findIndex((value) => !value);
  const scanGate = activeGate < 0 ? props.outcome.gateCount - 1 : activeGate;
  const scanningId = animation.displayed[scanGate];

  return (
    <UnitRevealFrame
      matchupLabel={props.matchupLabel}
      buildName={props.buildName}
      modeLabel="Holo draft"
      resultText={
        animation.allLocked ? resultAnnouncement(props.outcome) : null
      }
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(110deg, transparent 15%, rgba(70,225,255,.055) 35%, transparent 58%), repeating-linear-gradient(0deg, transparent 0 7px, rgba(105,135,214,.035) 8px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          zIndex: 8,
          left: 18,
          right: 18,
          top: 76,
          opacity: animation.allLocked ? 0.1 : 1,
          transform: animation.allLocked ? "scale(.96)" : "none",
          transition: "opacity 260ms ease, transform 260ms ease",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              color: "#7f8db7",
              fontSize: 10,
              fontWeight: 850,
              letterSpacing: ".14em",
              textTransform: "uppercase",
            }}
          >
            Candidate deck · honest landing odds
          </span>
          <span
            style={{
              color: "#75e7ff",
              fontSize: 10,
              fontWeight: 850,
              letterSpacing: ".12em",
              textTransform: "uppercase",
            }}
          >
            Drafting Gate {Math.max(0, scanGate) + 1}
          </span>
        </div>
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: `repeat(${props.outcome.pool.length}, minmax(0, 1fr))`,
            gap: 8,
            padding: 7,
            borderRadius: 15,
            border: "1px solid rgba(115,145,225,.25)",
            background: "rgba(5,8,17,.58)",
            overflow: "hidden",
          }}
        >
          {!animation.allLocked ? (
            <div
              className="rdz-unit-motion"
              style={{
                position: "absolute",
                zIndex: 6,
                top: -10,
                bottom: -10,
                width: "24%",
                borderLeft: "1px solid rgba(110,239,255,.72)",
                borderRight: "1px solid rgba(110,239,255,.45)",
                background:
                  "linear-gradient(90deg, transparent, rgba(87,226,255,.16), transparent)",
                boxShadow: "0 0 18px rgba(80,219,255,.18)",
                animation: "rdz-unit-scan 1.35s linear infinite",
              }}
            />
          ) : null}
          {props.outcome.pool.map((entry, index) => {
            const unit = gatewayUnitMeta(entry.id);
            const active = entry.id === scanningId && !animation.allLocked;
            const selected = props.outcome.picks.includes(entry.id);
            const pct = (props.outcome.probabilities[index] ?? 0) * 100;
            return (
              <div
                key={entry.id}
                style={{
                  position: "relative",
                  zIndex: 3,
                  minWidth: 0,
                  padding: "8px 5px 7px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  borderRadius: 11,
                  border: active
                    ? "1px solid rgba(112,234,255,.9)"
                    : selected && animation.locked.some(Boolean)
                      ? "1px solid rgba(244,204,92,.5)"
                      : "1px solid rgba(115,139,202,.2)",
                  background: active
                    ? "linear-gradient(180deg, rgba(58,174,220,.22), rgba(23,35,71,.36))"
                    : "linear-gradient(180deg, rgba(29,40,74,.46), rgba(8,12,23,.58))",
                  boxShadow: active
                    ? "0 0 22px rgba(72,218,255,.25), inset 0 0 18px rgba(86,197,255,.1)"
                    : "none",
                  transform: active ? "translateY(-3px)" : "none",
                  transition:
                    "transform 90ms linear, border-color 90ms linear, background 90ms linear",
                }}
              >
                <UnitPortrait id={entry.id} size={48} dim={!active && !selected} />
                <span
                  style={{
                    marginTop: 3,
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: active ? "#effdff" : "#b6bfdc",
                    fontSize: 11,
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                  }}
                >
                  {unit.name}
                </span>
                <span
                  style={{
                    marginTop: 1,
                    color: active ? "#78eaff" : "#7e8caf",
                    fontSize: 9,
                    fontWeight: 850,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 13,
            display: "flex",
            justifyContent: "center",
            gap: 10,
          }}
        >
          {animation.displayed.map((id, index) => {
            const locked = animation.locked[index];
            return (
              <div
                key={index}
                style={{
                  position: "relative",
                  width:
                    props.outcome.gateCount === 2
                      ? "min(210px, calc(50% - 5px))"
                      : "min(230px, 100%)",
                  boxSizing: "border-box",
                  height: 70,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 12px",
                  borderRadius: 12,
                  border: locked
                    ? "1px solid rgba(246,207,93,.74)"
                    : "1px dashed rgba(105,150,230,.5)",
                  background: locked
                    ? "rgba(126,99,27,.14)"
                    : "rgba(14,21,42,.72)",
                  boxShadow: locked
                    ? "0 0 24px rgba(245,201,79,.18)"
                    : "inset 0 0 18px rgba(61,95,178,.1)",
                  overflow: "hidden",
                }}
              >
                <UnitPortrait id={id} size={52} dim={!locked} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: locked ? "#f6d677" : "#7183b7",
                      fontSize: 9,
                      fontWeight: 900,
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                    }}
                  >
                    Gate {index + 1} {locked ? "· Locked" : "· Scanning"}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      color: locked ? "#f4f6ff" : "#9ba8ce",
                      fontSize: 15,
                      fontWeight: 850,
                    }}
                  >
                    {locked ? gatewayUnitMeta(id).name : "Awaiting pick"}
                  </div>
                </div>
                {locked ? (
                  <div
                    className="rdz-unit-motion"
                    style={{
                      position: "absolute",
                      right: 7,
                      top: 7,
                      padding: "2px 5px",
                      borderRadius: 4,
                      border: "1px solid rgba(247,214,109,.55)",
                      color: "#f8d970",
                      fontSize: 8,
                      fontWeight: 950,
                      letterSpacing: ".12em",
                      transform: "rotate(3deg)",
                      animation: "rdz-unit-pop 300ms ease both",
                    }}
                  >
                    LOCKED
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <UnitResultCard
        outcome={props.outcome}
        buildName={props.buildName}
        show={animation.allLocked}
      />
    </UnitRevealFrame>
  );
}
