"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";
import type {
  LiveGameEnvelope,
  LiveGamePayload,
  RandomizerIntentGate,
  RandomizerSpinEvent,
} from "./types";
import {
  EMPTY_BUILD_INTENT_LEDGER,
  parseOverlayBuildIntent,
  randomizerIntentGate,
  randomizerWindowAnchor,
  recordBuildIntent,
  type BuildIntentLedger,
  type RandomizerWindowAnchor,
} from "./buildIntentGate";
import { gameKeyFromTriggerKey, useGameStartTriggerKey } from "./gameStartTrigger";

/** Games whose roll this page already reported; a reload starts afresh. */
const REPORTED_ROLLS_KEPT = 16;

/**
 * Per-gameKey build check-in state from ``overlay:buildIntent``. Returns
 * the ledger and a stable handler for the overlay socket.
 */
export function useOverlayBuildIntents(): [BuildIntentLedger, (msg: unknown) => void] {
  const [ledger, setLedger] = useState<BuildIntentLedger>(EMPTY_BUILD_INTENT_LEDGER);
  const onBuildIntent = useCallback((msg: unknown) => {
    const event = parseOverlayBuildIntent(msg);
    if (!event) return;
    const receivedAtMs = Date.now();
    setLedger((prev) => recordBuildIntent(prev, event, receivedAtMs));
  }, []);
  return [ledger, onBuildIntent];
}

export interface RandomizerCheckin {
  /** Gate for the current match, passed to ``RandomizerWidget``. */
  intent: RandomizerIntentGate | null;
  /** ``RandomizerWidget`` spin callback: reports the roll, anchors the window. */
  onSpin: (spin: RandomizerSpinEvent) => void;
  /** Where the randomizer's visibility window must run in full from. */
  windowAnchor: RandomizerWindowAnchor | null;
}

/**
 * Wire one overlay client's randomizer into build check-in: derive the
 * current match's gate, report each real spin once on the client's own
 * overlay socket (``overlay:randomizer:rolled``), and remember when the
 * reveal actually started so the visibility window covers a held spin.
 *
 * ``live``/``liveGame`` must be exactly what the client hands the widget,
 * so both agree on the match.
 */
export function useRandomizerCheckin(
  socketRef: RefObject<Socket | null>,
  live: LiveGamePayload | null,
  liveGame: LiveGameEnvelope | null,
  ledger: BuildIntentLedger,
): RandomizerCheckin {
  const triggerKey = useGameStartTriggerKey(live, liveGame);
  const intent = randomizerIntentGate(ledger, gameKeyFromTriggerKey(triggerKey));
  const [lastSpin, setLastSpin] = useState<{ triggerKey: string; startedAtMs: number } | null>(null);
  // Outlives widget remounts (an enabledWidgets toggle re-spins the same
  // seeded outcome), so one page reports each game at most once. The
  // server keeps the first roll regardless.
  const reportedRolls = useRef<string[]>([]);

  const onSpin = useCallback((spin: RandomizerSpinEvent) => {
    setLastSpin({ triggerKey: spin.triggerKey, startedAtMs: spin.startedAtMs });
    const roll = spin.roll;
    if (!roll || reportedRolls.current.includes(roll.gameKey)) return;
    const socket = socketRef.current;
    if (!socket) return;
    reportedRolls.current = [
      ...reportedRolls.current.slice(-(REPORTED_ROLLS_KEPT - 1)),
      roll.gameKey,
    ];
    socket.emit("overlay:randomizer:rolled", { gameKey: roll.gameKey, buildId: roll.buildId });
  }, [socketRef]);

  return {
    intent,
    onSpin,
    windowAnchor: randomizerWindowAnchor(triggerKey, lastSpin, intent),
  };
}
