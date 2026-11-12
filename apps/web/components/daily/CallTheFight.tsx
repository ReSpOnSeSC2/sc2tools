"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar } from "@/components/ui/Skeleton";
import { prefersReducedMotion } from "@/lib/a11y/useReducedMotion";
import { isOpeningUnit, type DailyFight } from "@/lib/daily/clip";
import { CALLS, FIGHTS_PER_DAY, gradeTrade, type FightCall } from "@/lib/daily/rules";
import type { ClipPhase } from "./ClipPlayer";
import field from "./field.module.css";

const ClipPlayer = dynamic(() => import("./ClipPlayer"), {
  ssr: false,
  loading: () => <div aria-hidden className="h-full w-full bg-bg-elevated" />,
});

const OPENING_QUESTION = "The fight starts in one second. Who loses fewer resources?";
const CHOICES = "grid grid-cols-2 gap-2 sm:grid-cols-5";
const WIDE_CHOICE = "col-span-2 sm:col-span-1";
const FIELD = "aspect-[3/2] max-h-80 w-full border-y border-line";

export function FightSkeleton() {
  return (
    <div role="status" aria-label="Loading the Daily" className="space-y-4">
      <div className="flex h-5 items-center justify-between gap-6">
        <SkeletonBar className="h-4 w-36" />
        <SkeletonBar className="h-4 w-20" />
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-bg-surface">
        <div className="flex items-center justify-between gap-6 px-4 py-4 sm:px-6">
          <SkeletonBar className="h-6 w-32" />
          <SkeletonBar className="h-4 w-20" />
        </div>
        <div className={FIELD}><SkeletonBar className="h-full w-full" /></div>
        <div className="grid grid-cols-2 gap-3 border-b border-line px-4 py-3 sm:px-6">
          {[0, 1].map(side => <div key={side} className="space-y-2">
            <SkeletonBar className="h-4 w-20" />
            <SkeletonBar className="h-4 w-16" />
          </div>)}
        </div>
        <div className="min-h-36 space-y-3 p-4 sm:p-6">
          <div className="relative">
            <p aria-hidden className="invisible text-body">{OPENING_QUESTION}</p>
            <SkeletonBar className="absolute inset-y-1 left-0 w-4/5" />
          </div>
          <div className={CHOICES}>
            {CALLS.map((label, index) => <SkeletonBar key={label}
              className={`h-11 rounded-full ${index === 2 ? WIDE_CHOICE : ""}`} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function armyText(fight: DailyFight, side: 0 | 1): string {
  const groups = new Map<string, number>();
  for (const unit of fight.units) {
    if (unit.side !== side || !isOpeningUnit(unit)) continue;
    const label = unit.unit.replace(/([a-z])([A-Z])/g, "$1 $2");
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  return Array.from(groups, ([unit, count]) => count + " " + unit).join(", ");
}

function ArmyLine({ fight }: { fight: DailyFight }) {
  return (
    <dl className="grid grid-cols-2 gap-3 border-b border-line px-4 py-3 text-caption sm:px-6">
      <div className="min-w-0">
        <dt className="font-bold text-text">Blue army</dt>
        <dd className="break-words text-text-muted">{armyText(fight, 0)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="font-bold text-text">Red army</dt>
        <dd className="break-words text-text-muted">{armyText(fight, 1)}</dd>
      </div>
    </dl>
  );
}

type Props = {
  fight: DailyFight;
  slot: number;
  terrain?: string;
  onNext: (correct: boolean) => void;
};

type Round = { phase: "frozen" } | { phase: "playing" | "result"; call: FightCall };
const NUMBER = new Intl.NumberFormat("en");

export function CallTheFight({ fight, slot, terrain, onNext }: Props) {
  const [round, setRound] = useState<Round>({ phase: "frozen" });
  const title = useRef<HTMLHeadingElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const previousPhase = useRef<ClipPhase>("frozen");
  const finish = useCallback(() => {
    setRound(current => current.phase === "playing" ? { ...current, phase: "result" } : current);
  }, []);

  useEffect(() => {
    if (previousPhase.current !== round.phase) {
      if (round.phase === "playing") action.current?.focus();
      if (round.phase === "result") title.current?.focus();
      previousPhase.current = round.phase;
    } else if (slot > 0 && round.phase === "frozen") title.current?.focus();
  }, [round.phase, slot]);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-bg-surface" aria-label={"Fight " + (slot + 1)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-4 sm:px-6">
        <h2 ref={title} tabIndex={-1} className="font-display text-heading font-bold text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {round.phase === "result" ? "Trade result" : "Call the fight"}
        </h2>
        <p className="text-caption font-semibold tabular-nums text-text-muted">Fight {slot + 1} of {FIGHTS_PER_DAY}</p>
      </div>
      <div className={`replay-scope ${FIELD} bg-bg ${terrain ? "" : field.practice}`}>
        <ClipPlayer fight={fight} phase={round.phase} terrain={terrain} onEnd={finish} />
      </div>
      <ArmyLine fight={fight} />
      <div className="min-h-36 space-y-3 p-4 sm:p-6">
        {round.phase === "frozen" && (
          <>
            <p className="text-body text-text-muted">{OPENING_QUESTION}</p>
            <div className={CHOICES} role="group" aria-label="Your call">
              {CALLS.map((label, index) => (
                <Button key={label} variant="secondary" size="sm"
                  className={`min-h-11 !px-2 text-center leading-tight ${index === 2 ? WIDE_CHOICE : ""}`}
                  onClick={() => setRound({ phase: prefersReducedMotion() ? "result" : "playing", call: index as FightCall })}>
                  <span>{label}</span>
                </Button>
              ))}
            </div>
          </>
        )}
        {round.phase === "playing" && (
          <>
            <p className="text-body text-text-muted" role="status">Playing the fight.</p>
            <Button ref={action} variant="secondary" className="min-h-11" onClick={finish}
              onKeyDown={event => { if (event.key === "Escape") finish(); }}>Skip to result</Button>
          </>
        )}
        {round.phase === "result" && <TradeResult fight={fight} call={round.call} slot={slot} onNext={onNext} />}
      </div>
    </section>
  );
}

function TradeResult({ fight, call, slot, onNext }: Props & { call: FightCall }) {
  const [blue, red] = fight.losses;
  const answer = gradeTrade(blue, red), correct = answer === call;
  return (
    <>
      <p className="text-body font-bold text-text">{CALLS[answer]}. {correct ? "Correct call." : "Your call was " + CALLS[call].toLowerCase() + "."}</p>
      <p className="text-caption text-text-muted">Resources lost: Blue {NUMBER.format(blue)}, Red {NUMBER.format(red)}.</p>
      <Button className="min-h-11" onClick={() => onNext(correct)}>
        {slot + 1 === FIGHTS_PER_DAY ? "See results" : "Next fight"}
      </Button>
    </>
  );
}
