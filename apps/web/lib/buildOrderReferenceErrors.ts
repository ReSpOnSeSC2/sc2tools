import config from "../../api/src/config/referenceBuildOrder.json";
import {
  readReferenceBuildOrder,
  REFERENCE_ORDER_LIMITS as limits,
  validReferenceLine,
  validReferenceNumber,
} from "./buildOrderReference";

const INVALID_PLAN = "The reference plan is invalid. Paste or fill it again.";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function headerError(row: Record<string, unknown>): string | null {
  if (row.v !== 1 || !config.sources.includes(String(row.source)) || !Array.isArray(row.steps)) {
    return INVALID_PLAN;
  }
  if (row.steps.length > limits.steps) return `Keep at most ${limits.steps} reference steps.`;
  if (row.sourceGameId !== undefined && !validReferenceLine(row.sourceGameId, limits.gameIdChars, true)) {
    return "The source replay ID is invalid. Reopen this build from its source game.";
  }
  return null;
}

function stepError(step: unknown): string | null {
  if (!isRecord(step)) return "delete this invalid step and add it again.";
  const checks = [
    [validReferenceNumber(step.t, limits.seconds, true), "use a valid m:ss time up to 1440:00, or leave it blank."],
    [validReferenceNumber(step.supply, limits.supply),
      `use supply from 0 to ${limits.supply.toLocaleString("en-US")}, or leave it blank.`],
    [validReferenceLine(step.action, limits.actionChars, true),
      `enter an action of at most ${limits.actionChars} characters on one line.`],
    [step.note === undefined || validReferenceLine(step.note, limits.noteChars),
      `keep the note on one line and within ${limits.noteChars} characters.`],
    [step.supplyApprox === undefined || typeof step.supplyApprox === "boolean",
      "re-enter its supply to fix the approximation flag."],
  ] as const;
  return checks.find(([valid]) => !valid)?.[1] ?? null;
}

/** Editor-only explanations stay out of reference-display bundles. */
export function referenceBuildOrderError(raw: unknown): string | null {
  if (readReferenceBuildOrder(raw)) return null;
  if (!isRecord(raw)) return INVALID_PLAN;
  const invalidHeader = headerError(raw);
  if (invalidHeader) return invalidHeader;
  // headerError has checked the array shape; narrow again before reading rows.
  if (!Array.isArray(raw.steps)) return INVALID_PLAN;
  for (const [index, step] of raw.steps.entries()) {
    const error = stepError(step);
    if (error) return `Step ${index + 1}: ${error}`;
  }
  return "Check the reference build order.";
}
