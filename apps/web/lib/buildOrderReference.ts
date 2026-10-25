import config from "../../api/src/config/referenceBuildOrder.json";

export const REFERENCE_ORDER_LIMITS = config.limits;
export interface ReferenceBuildStep {
  /** Supply-only imports retain an unknown time, never an invented 0:00. */
  t: number | null;
  supply: number | null;
  supplyApprox?: boolean;
  /** Exact canonical token when known; unknown reference text is allowed. */
  action: string;
  /** Shareable step instruction, separate from private build notes. */
  note?: string;
}
export interface ReferenceBuildOrder {
  v: 1;
  steps: ReferenceBuildStep[];
  source: "game" | "paste" | "manual";
  /** Private provenance. Omitted from all public community snapshots. */
  sourceGameId?: string;
}

const line = (value: unknown, max: number, required = false): value is string => typeof value === "string" && Array.from(value).length <= max
  && (!required || value.trim().length > 0) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
const numberOrNull = (value: unknown, max: number, integer = false) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max && (!integer || Number.isInteger(value));

/** Read/write display contract. No token allowlist: unknown actions warn in the
 * editor and do not turn a valid reference order into a failed match rule. */
export function readReferenceBuildOrder(raw: unknown): ReferenceBuildOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>, limits = REFERENCE_ORDER_LIMITS;
  if (row.v !== 1 || !config.sources.includes(String(row.source)) || !Array.isArray(row.steps) || row.steps.length > limits.steps) return null;
  if (row.sourceGameId !== undefined && (!line(row.sourceGameId, limits.gameIdChars, true) || !/^[A-Za-z0-9._:-]+$/.test(row.sourceGameId))) return null;
  const steps: ReferenceBuildStep[] = [];
  for (const candidate of row.steps) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const step = candidate as Record<string, unknown>;
    if (!numberOrNull(step.t, limits.seconds, true) || !numberOrNull(step.supply, limits.supply) || !line(step.action, limits.actionChars, true)
      || step.note !== undefined && !line(step.note, limits.noteChars) || step.supplyApprox !== undefined && typeof step.supplyApprox !== "boolean") return null;
    steps.push({ t: step.t as number | null, supply: step.supply as number | null, action: step.action,
      ...(step.supplyApprox !== undefined ? { supplyApprox: step.supplyApprox as boolean } : {}), ...(step.note !== undefined ? { note: step.note as string } : {}) });
  }
  return { v: 1, source: row.source as ReferenceBuildOrder["source"], steps, ...(row.sourceGameId !== undefined ? { sourceGameId: row.sourceGameId } : {}) };
}

/** An explicitly separate public projection never copies private replay ids. */
export function publicReferenceBuildOrder(raw: unknown): Omit<ReferenceBuildOrder, "sourceGameId"> | null {
  const order = readReferenceBuildOrder(raw);
  return order ? { v: 1, source: order.source, steps: order.steps } : null;
}
