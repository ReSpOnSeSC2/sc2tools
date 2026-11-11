/**
 * The opt-in supporter wall on /donate: players who asked to be listed,
 * after an administrator approved the entry. Only a display name, an
 * optional short message and the month appear; never an amount, an account
 * or a link.
 */

export const SUPPORTER_NAME_MAX = 40;
export const SUPPORTER_MESSAGE_MAX = 80;
export const SUPPORTER_WALL_SETTINGS_HREF = "/settings?tab=profile#supporter-wall";

export interface SupporterEntry {
  displayName: string;
  message: string;
}
export interface EarlierSupporter extends SupporterEntry {
  /** "YYYY-MM". */
  month: string;
}
export interface SupporterWallData {
  month: string;
  thisMonth: SupporterEntry[];
  earlier: EarlierSupporter[];
}
export type SupporterStatus = "pending" | "approved" | "rejected";
export interface OwnSupporterEntry extends EarlierSupporter {
  status: SupporterStatus;
  consentAt: string | null;
  updatedAt: string | null;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function entry(raw: unknown): SupporterEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const displayName = text(value.displayName, SUPPORTER_NAME_MAX);
  return displayName ? { displayName, message: text(value.message, SUPPORTER_MESSAGE_MAX) } : null;
}

/** Bounded, display-safe copy of the public API answer (null when unusable). */
export function normalizeSupporterWall(raw: unknown): SupporterWallData | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.month !== "string" || !Array.isArray(value.thisMonth) || !Array.isArray(value.earlier)) return null;
  const thisMonth = value.thisMonth.map(entry).filter((item): item is SupporterEntry => item !== null).slice(0, 200);
  const earlier = value.earlier.flatMap((item) => {
    const base = entry(item);
    const month = item && typeof item === "object" ? (item as Record<string, unknown>).month : null;
    return base && typeof month === "string" && /^\d{4}-\d{2}$/.test(month) ? [{ ...base, month }] : [];
  }).slice(0, 200);
  return { month: value.month, thisMonth, earlier };
}
