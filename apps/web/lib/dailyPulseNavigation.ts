import type { PulseCard } from "./dailyPulse";
import { hrefForTab, opponentDossierHref } from "@/components/analyzer/tabs";

/** The caller supplies its serialized global filter snapshot, never section state. */
export function dailyPulseHref(card: PulseCard, globalQuery = ""): string | null {
  const opponent = card.targetQuery?.pulseId || card.targetOpponentId;
  const path = opponent ? opponentDossierHref(opponent) : card.targetTab ? hrefForTab(card.targetTab) : null;
  if (!path) return null;
  const query = new URLSearchParams(globalQuery);
  if (!opponent) {
    for (const key of ["q", "focus"] as const) {
      const value = card.targetQuery?.[key];
      if (typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) query.set(key, value);
    }
  }
  return query.size ? `${path}?${query}` : path;
}
