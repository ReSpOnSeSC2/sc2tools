"use client";
import { useEffect, useReducer, useRef } from "react";
import { gameMomentIdentity, MOMENT_FRESH_MS, sanitizeGameMoment, type GameMoment, type GameMomentConfig } from "@/lib/gameMoments";
type State = { queue: GameMoment[]; active: GameMoment | null };
type Action = { type: "enqueue"; moment: GameMoment } | { type: "expire" } | { type: "reset" } | { type: "sync"; blocked: boolean; paused: boolean; config: GameMomentConfig; now: number };
const initial: State = { queue: [], active: null };
function reduce(state: State, action: Action): State {
  if (action.type === "reset") return state.active || state.queue.length ? initial : state;
  if (action.type === "enqueue") return state.queue.length < 18 ? { ...state, queue: [...state.queue, action.moment] } : state;
  if (action.type === "expire") return state.active ? { ...state, active: null } : state;
  const allowed = (moment: GameMoment) => !action.paused && action.config.moments[moment.kind].enabled && action.now - moment.atMs <= MOMENT_FRESH_MS;
  const queue = state.queue.filter(allowed); let active = state.active && allowed(state.active) ? state.active : null;
  if (action.blocked && active) { queue.unshift(active); active = null; }
  if (!action.blocked && !active) active = queue.shift() ?? null;
  return active === state.active && queue.length === state.queue.length && queue.every((moment, index) => moment === state.queue[index]) ? state : { queue, active };
}
/** Supporter arrivals preempt Ladder without replaying its sound. Paused or
 * disabled moments are consumed, and bounded stale queues never replay later. */
export function useGameMomentQueue({ event, config, ready, paused, blocked, durationMs }: {
  event: unknown; config: GameMomentConfig; ready: boolean; paused: boolean; blocked: boolean; durationMs: number;
}) {
  const [state, dispatch] = useReducer(reduce, initial), seen = useRef(new Set<string>());
  useEffect(() => {
    if (event === null) { dispatch({ type: "reset" }); return; }
    if (!ready) return;
    // The socket host retains a bounded batch, including same-turn arrivals.
    for (const raw of Array.isArray(event) ? event : [event]) {
      const moment = sanitizeGameMoment(raw); if (!moment) continue;
      const key = gameMomentIdentity(moment); if (seen.current.has(key)) continue;
      seen.current.add(key); while (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!);
      if (!paused && config.moments[moment.kind].enabled) dispatch({ type: "enqueue", moment });
    }
  }, [event, config, paused, ready]);
  useEffect(() => { dispatch({ type: "sync", blocked: blocked || !ready, paused, config, now: Date.now() }); }, [blocked, config, paused, ready, state.queue, state.active]);
  useEffect(() => {
    if (!state.active || blocked || paused) return;
    const timer = setTimeout(() => dispatch({ type: "expire" }), Math.max(0, Math.min(durationMs, MOMENT_FRESH_MS - (Date.now() - state.active.atMs))));
    return () => clearTimeout(timer);
  }, [state.active, blocked, paused, durationMs]);
  return { moment: event !== null && ready && !blocked && !paused ? state.active : null, pending: state.queue.length > 0 || state.active !== null };
}
