import type { BuildOrderEvent } from "./build-events";
import { normalizeReferenceAction } from "./buildOrderText";
import { BUILD_TOKENS } from "./buildTokens";
import { REFERENCE_ORDER_LIMITS, type ReferenceBuildOrder, type ReferenceBuildStep } from "./buildOrderReference";

const workers = /^(?:Build|Train)?(?:Probe|SCV|Drone|MULE)$/i;
const army = new Set(BUILD_TOKENS.filter(token => token.kind === "unit" && !workers.test(token.entity)).map(token => token.token));

/** Workers disappear as rows; recorded supply on the retained events survives.
 * No supply or timing is inferred from row counts. */
export function referenceFromGame(events: readonly BuildOrderEvent[], sourceGameId?: string): ReferenceBuildOrder {
  const steps = events.slice(0, 10000).filter(event => event && typeof event.name === "string" && event.name.length <= REFERENCE_ORDER_LIMITS.actionChars * 2 && Number.isFinite(event.time) && event.time >= 0 && event.time <= REFERENCE_ORDER_LIMITS.seconds)
    .slice().sort((a, b) => a.time - b.time).flatMap(event => {
      const action = normalizeReferenceAction(event.name).action;
      if (!action || workers.test(action) || Array.from(action).length > REFERENCE_ORDER_LIMITS.actionChars) return [];
      const upgrade = event.category === "upgrade" || /^Research[A-Z]/.test(action);
      const completion = typeof event.complete_time === "number" && Number.isFinite(event.complete_time) && event.complete_time >= event.time && event.complete_time <= REFERENCE_ORDER_LIMITS.seconds ? Math.round(event.complete_time) : null;
      const startSupply = Number.isFinite(event.supply) && event.supply! >= 0 && event.supply! <= 1000 ? event.supply! : null;
      return [{ t: upgrade ? completion : Math.round(event.time), supply: upgrade ? null : startSupply,
        action, ...(!upgrade && event.supplyApprox ? { supplyApprox: true } : {}), ...(upgrade ? { note: `Start recorded at ${referenceClock(Math.round(event.time))}${startSupply === null ? "" : ` (supply ${event.supplyApprox ? "≈" : ""}${startSupply})`}${completion === null ? "; completion not supplied." : "."}` } : {}) }];
    }).sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity)).slice(0, REFERENCE_ORDER_LIMITS.steps);
  return { v: 1, source: "game", steps, ...(sourceGameId ? { sourceGameId } : {}) };
}

/** Explicit compaction retains the first clock and states the repeated count.
 * Only adjacent army rows with the same action are collapsed. */
export function collapseReferenceArmy(steps: readonly ReferenceBuildStep[]): ReferenceBuildStep[] {
  const out: ReferenceBuildStep[] = [];
  for (let index = 0; index < steps.length; index++) {
    const first = steps[index]; let end = index;
    if (army.has(first.action) && !first.note) while (end + 1 < steps.length && steps[end + 1].action === first.action && !steps[end + 1].note) end++;
    out.push(end === index ? { ...first } : { ...first, note: `Repeated ${end - index + 1} times${steps[end].t === null ? " (last time unknown)" : `; last at ${referenceClock(steps[end].t!)}`}.` });
    index = end;
  }
  return out;
}
export const referenceClock = (t: number | null) => t === null ? "" : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
export function parseReferenceClock(value: string): number | null {
  if (!value.trim()) return null;
  const match = /^(\d{1,4}):([0-5]\d)$/.exec(value.trim());
  const t = match ? Number(match[1]) * 60 + Number(match[2]) : -1;
  return t <= REFERENCE_ORDER_LIMITS.seconds ? t : -1;
}
