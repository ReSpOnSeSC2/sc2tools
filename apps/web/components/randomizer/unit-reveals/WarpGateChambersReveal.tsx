"use client";

import { gatewayUnitMeta } from "@/lib/randomizer/gatewayUnits";
import { useRevealSound } from "@/components/randomizer/reveals/revealSound";
import {
  resultAnnouncement,
  UnitOddsStrip,
  UnitPortrait,
  UnitResultCard,
  UnitRevealFrame,
  type UnitRevealProps,
  useAnimatedUnitPicks,
} from "./unitRevealShared";

export const WARP_GATE_DURATION_MS = 4_650;
const LOCK_TIMES = [2_650, 3_300] as const;

/** Dual Protoss chambers charge, decode candidates, then warp each pick in. */
export function WarpGateChambersReveal(props: UnitRevealProps) {
  const animation = useAnimatedUnitPicks({
    outcome: props.outcome,
    spinId: props.spinId,
    lockTimesMs: LOCK_TIMES,
    durationMs: WARP_GATE_DURATION_MS,
    onComplete: props.onComplete,
  });
  useRevealSound({
    style: "gacha",
    spinId: props.spinId,
    durationMs: WARP_GATE_DURATION_MS,
    reducedMotion: animation.reducedMotion,
  });

  return (
    <UnitRevealFrame
      matchupLabel={props.matchupLabel}
      buildName={props.buildName}
      modeLabel="Warp chambers"
      resultText={
        animation.allLocked ? resultAnnouncement(props.outcome) : null
      }
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          opacity: 0.34,
          backgroundImage:
            "linear-gradient(rgba(91,116,211,.12) 1px, transparent 1px), linear-gradient(90deg, rgba(91,116,211,.12) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          maskImage: "linear-gradient(to bottom, transparent 8%, black 35%, black 82%, transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          zIndex: 8,
          left: 22,
          right: 22,
          top: 78,
          bottom: 52,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: props.outcome.gateCount === 2 ? "clamp(14px, 5vw, 42px)" : 0,
          opacity: animation.allLocked ? 0.14 : 1,
          transform: animation.allLocked ? "scale(.95)" : "none",
          transition: "opacity 260ms ease, transform 260ms ease",
        }}
      >
        {animation.displayed.map((id, index) => {
          const locked = animation.locked[index];
          const meta = gatewayUnitMeta(id);
          return (
            <div
              key={index}
              style={{
                width:
                  props.outcome.gateCount === 2
                    ? "min(220px, calc(50% - 7px))"
                    : "min(245px, 100%)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <div
                style={{
                  color: locked ? "#f6d472" : "#7485bd",
                  fontSize: 10,
                  fontWeight: 900,
                  letterSpacing: ".17em",
                  textTransform: "uppercase",
                }}
              >
                {locked ? `Gate ${index + 1} locked` : `Gate ${index + 1} charging`}
              </div>
              <div
                style={{
                  position: "relative",
                  width: "min(174px, 100%)",
                  aspectRatio: "1",
                  marginTop: 8,
                  display: "grid",
                  placeItems: "center",
                  clipPath:
                    "polygon(25% 5%,75% 5%,98% 50%,75% 95%,25% 95%,2% 50%)",
                  background: locked
                    ? "radial-gradient(circle, rgba(247,211,105,.25), rgba(68,80,142,.15) 55%, rgba(6,9,18,.92) 70%)"
                    : "radial-gradient(circle, rgba(72,190,255,.24), rgba(73,93,185,.16) 58%, rgba(6,9,18,.9) 72%)",
                  border: `1px solid ${locked ? "rgba(248,213,111,.75)" : "rgba(117,151,255,.5)"}`,
                  boxShadow: locked
                    ? "0 0 36px rgba(247,201,78,.34), inset 0 0 30px rgba(247,217,125,.14)"
                    : "0 0 30px rgba(74,139,255,.24), inset 0 0 32px rgba(71,174,255,.12)",
                }}
              >
                <div
                  className="rdz-unit-motion"
                  style={{
                    position: "absolute",
                    inset: 9,
                    borderRadius: "50%",
                    border: "2px dashed rgba(112,156,255,.56)",
                    animation: locked
                      ? "none"
                      : "rdz-unit-rotate 1.35s linear infinite",
                  }}
                />
                <div
                  className="rdz-unit-motion"
                  style={{
                    position: "absolute",
                    inset: 23,
                    borderRadius: "50%",
                    border: "1px solid rgba(95,232,255,.48)",
                    borderLeftColor: "transparent",
                    borderRightColor: "transparent",
                    animation: locked
                      ? "none"
                      : "rdz-unit-reverse .92s linear infinite",
                  }}
                />
                <div
                  className={locked ? "rdz-unit-motion" : undefined}
                  style={{
                    position: "relative",
                    zIndex: 3,
                    width: 82,
                    height: 82,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 18,
                    background: locked
                      ? "rgba(245,202,88,.13)"
                      : "rgba(17,24,47,.76)",
                    animation: locked
                      ? "rdz-unit-pop 420ms cubic-bezier(.2,1.35,.35,1) both"
                      : "none",
                    filter: locked
                      ? "drop-shadow(0 0 15px rgba(250,213,102,.6))"
                      : "none",
                  }}
                >
                  <UnitPortrait id={id} size={74} />
                </div>
                {!locked ? (
                  <div
                    className="rdz-unit-motion"
                    style={{
                      position: "absolute",
                      zIndex: 5,
                      top: 16,
                      bottom: 16,
                      width: 2,
                      background:
                        "linear-gradient(transparent, rgba(120,239,255,.9), transparent)",
                      boxShadow: "0 0 14px rgba(109,230,255,.9)",
                      animation: "rdz-unit-scan 1.1s linear infinite",
                    }}
                  />
                ) : null}
              </div>
              <div
                style={{
                  marginTop: 5,
                  color: locked ? "#fff1b8" : "#b7c2e5",
                  fontSize: 15,
                  fontWeight: 850,
                  letterSpacing: ".02em",
                }}
              >
                {locked ? meta.name : "Decoding…"}
              </div>
            </div>
          );
        })}
      </div>
      <UnitOddsStrip outcome={props.outcome} hidden={animation.allLocked} />
      <UnitResultCard
        outcome={props.outcome}
        buildName={props.buildName}
        show={animation.allLocked}
      />
    </UnitRevealFrame>
  );
}
