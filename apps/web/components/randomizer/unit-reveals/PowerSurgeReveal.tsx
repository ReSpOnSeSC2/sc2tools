"use client";

import { getIconPath } from "@/lib/sc2-icons";
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

export const POWER_SURGE_DURATION_MS = 4_700;
const LOCK_TIMES = [2_550, 3_250] as const;
const PYLON_ICON = getIconPath("Pylon", "building") ?? "/icons/sc2/buildings/pylon.png";

/** Weighted circuit nodes route a psionic surge into one or two Gate sockets. */
export function PowerSurgeReveal(props: UnitRevealProps) {
  const animation = useAnimatedUnitPicks({
    outcome: props.outcome,
    spinId: props.spinId,
    lockTimesMs: LOCK_TIMES,
    durationMs: POWER_SURGE_DURATION_MS,
    onComplete: props.onComplete,
  });
  useRevealSound({
    style: "asteroid",
    spinId: props.spinId,
    durationMs: POWER_SURGE_DURATION_MS,
    reducedMotion: animation.reducedMotion,
  });

  return (
    <UnitRevealFrame
      matchupLabel={props.matchupLabel}
      buildName={props.buildName}
      modeLabel="Pylon circuit"
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
            "radial-gradient(circle at 50% 55%, rgba(89,215,255,.14), transparent 21%), repeating-radial-gradient(circle at 50% 55%, transparent 0 38px, rgba(104,134,231,.04) 39px 40px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          zIndex: 8,
          left: 18,
          right: 18,
          top: 75,
          bottom: 13,
          opacity: animation.allLocked ? 0.12 : 1,
          transform: animation.allLocked ? "scale(.95)" : "none",
          transition: "opacity 260ms ease, transform 260ms ease",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${props.outcome.pool.length}, minmax(0, 1fr))`,
            gap: 8,
          }}
        >
          {props.outcome.pool.map((entry, index) => {
            const unit = gatewayUnitMeta(entry.id);
            const probability = props.outcome.probabilities[index] ?? 0;
            const active = animation.displayed.some(
              (id, slot) => id === entry.id && !animation.locked[slot],
            );
            const locked = props.outcome.picks.some(
              (id, slot) => id === entry.id && animation.locked[slot],
            );
            return (
              <div
                key={entry.id}
                style={{
                  position: "relative",
                  minWidth: 0,
                  padding: "6px 5px 8px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  borderRadius: 11,
                  border: locked
                    ? "1px solid rgba(246,210,104,.7)"
                    : active
                      ? "1px solid rgba(103,235,255,.78)"
                      : "1px solid rgba(111,137,203,.2)",
                  background: locked
                    ? "rgba(122,96,27,.16)"
                    : active
                      ? "rgba(45,157,202,.18)"
                      : "rgba(8,13,26,.6)",
                  boxShadow: active
                    ? "0 0 20px rgba(67,221,255,.24)"
                    : locked
                      ? "0 0 20px rgba(247,205,88,.18)"
                      : "none",
                  transition: "border-color 100ms linear, background 100ms linear",
                }}
              >
                <UnitPortrait id={entry.id} size={43} dim={!active && !locked} />
                <span
                  style={{
                    marginTop: 2,
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: active || locked ? "#edf6ff" : "#9aa6c8",
                    fontSize: 10,
                    fontWeight: 800,
                    whiteSpace: "nowrap",
                  }}
                >
                  {unit.name}
                </span>
                <div
                  style={{
                    width: "76%",
                    height: 3,
                    marginTop: 5,
                    overflow: "hidden",
                    borderRadius: 99,
                    background: "rgba(92,112,167,.22)",
                  }}
                >
                  <div
                    className={active ? "rdz-unit-motion" : undefined}
                    style={{
                      width: `${Math.max(4, probability * 100)}%`,
                      height: "100%",
                      borderRadius: 99,
                      background: locked ? "#f2cb63" : "#63daf5",
                      boxShadow: active ? "0 0 9px #70eaff" : "none",
                      animation: active
                        ? "rdz-unit-beam .36s ease-in-out infinite"
                        : "none",
                    }}
                  />
                </div>
                <span
                  style={{
                    marginTop: 3,
                    color: active ? "#72e6ff" : "#7181a9",
                    fontSize: 9,
                    fontWeight: 850,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {(probability * 100).toFixed(1)}%
                </span>
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "100%",
                    width: 1,
                    height: 35,
                    background: active
                      ? "linear-gradient(#67e7ff, transparent)"
                      : "linear-gradient(rgba(91,120,198,.3), transparent)",
                    boxShadow: active ? "0 0 8px #67e7ff" : "none",
                  }}
                />
              </div>
            );
          })}
        </div>

        <div
          style={{
            position: "absolute",
            left: "10%",
            right: "10%",
            top: 128,
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgba(91,157,238,.45) 18%, rgba(105,229,255,.72) 50%, rgba(91,157,238,.45) 82%, transparent)",
            boxShadow: "0 0 8px rgba(87,211,255,.25)",
          }}
        >
          {!animation.allLocked ? (
            <span
              className="rdz-unit-motion"
              style={{
                position: "absolute",
                top: -2,
                width: "24%",
                height: 5,
                borderRadius: 99,
                background:
                  "linear-gradient(90deg, transparent, #a9f4ff, transparent)",
                boxShadow: "0 0 11px #67e7ff",
                animation: "rdz-unit-flow 1.05s linear infinite",
              }}
            />
          ) : null}
        </div>

        <div
          className="rdz-unit-motion"
          style={{
            position: "absolute",
            left: "50%",
            top: 122,
            width: 82,
            height: 82,
            display: "grid",
            placeItems: "center",
            transform: "translateX(-50%)",
            borderRadius: "50%",
            border: "1px solid rgba(104,224,255,.42)",
            background:
              "radial-gradient(circle, rgba(93,229,255,.22), rgba(42,69,149,.13) 54%, rgba(5,8,16,.68) 70%)",
            boxShadow:
              "0 0 26px rgba(89,220,255,.24), inset 0 0 22px rgba(106,171,255,.16)",
            animation: animation.allLocked
              ? "none"
              : "rdz-unit-float 1.6s ease-in-out infinite",
          }}
        >
          {/* A direct local PNG avoids an image-optimizer request inside OBS. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={PYLON_ICON}
            alt=""
            aria-hidden="true"
            width={64}
            height={64}
            style={{
              width: 64,
              height: 64,
              objectFit: "contain",
              filter: "drop-shadow(0 0 12px rgba(105,229,255,.65))",
            }}
          />
        </div>

        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 0,
            display: "flex",
            gap: 10,
            transform: "translateX(-50%)",
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
                      ? "min(180px, calc(50% - 5px))"
                      : "min(215px, 100%)",
                  boxSizing: "border-box",
                  height: 68,
                  padding: "7px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  borderRadius: 12,
                  border: locked
                    ? "1px solid rgba(247,211,101,.72)"
                    : "1px solid rgba(103,170,234,.42)",
                  background: locked
                    ? "linear-gradient(120deg, rgba(119,91,25,.2), rgba(20,27,48,.88))"
                    : "rgba(11,18,36,.86)",
                  boxShadow: locked
                    ? "0 0 23px rgba(246,205,83,.17)"
                    : "inset 0 0 18px rgba(79,145,233,.1)",
                  overflow: "hidden",
                }}
              >
                {!locked ? (
                  <div
                    className="rdz-unit-motion"
                    style={{
                      position: "absolute",
                      left: -30,
                      right: -30,
                      top: 0,
                      height: 2,
                      background:
                        "linear-gradient(90deg, transparent, #86eeff, transparent)",
                      boxShadow: "0 0 8px #72dff8",
                      animation: "rdz-unit-flow .78s linear infinite",
                    }}
                  />
                ) : null}
                <UnitPortrait id={id} size={49} dim={!locked} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: locked ? "#f3cf69" : "#7284b4",
                      fontSize: 9,
                      fontWeight: 900,
                      letterSpacing: ".13em",
                      textTransform: "uppercase",
                    }}
                  >
                    Gate {index + 1} circuit
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      color: locked ? "#f2f6ff" : "#a0acca",
                      fontSize: 14,
                      fontWeight: 850,
                    }}
                  >
                    {locked ? gatewayUnitMeta(id).name : "Routing energy…"}
                  </div>
                </div>
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
