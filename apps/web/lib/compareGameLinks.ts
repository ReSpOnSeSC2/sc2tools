import { isPublicReplayReference } from "@/lib/replayRouteAccess";

export const COMPARE_REFERENCES_PATH = "/v1/compare-games/references";

/** Old bookmarks may contain fallback IDs with opponent names. They resolve through a private POST. */
export function isLegacyCompareGameId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function compareHref(a: string | null, b: string | null): string {
  const query = new URLSearchParams();
  if (a && isPublicReplayReference(a)) query.set("a", a);
  if (b && isPublicReplayReference(b)) query.set("b", b);
  return query.size ? "/app/compare?" + query : "/app/compare";
}

export interface CompareReferences { references: (string | null)[] }

export function compareReferenceRequest(gameIds: string[]): RequestInit {
  return { method: "POST", body: JSON.stringify({ gameIds }) };
}
