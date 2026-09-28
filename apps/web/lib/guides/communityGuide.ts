/**
 * Link a community build to its canonical guide page — exact names only.
 *
 * A community build points at a guide only when the guide's matchup
 * payload lists a PUBLISHED build, in the same matchup, whose catalog
 * name ("PvZ - Stargate into Glaives") or display name ("Stargate into
 * Glaives") equals the community build's `build.name` or title, compared
 * trimmed and case-insensitively. No fuzzy matching: a near miss links
 * nothing. Mirrors the API's guide → community rule (contract §6).
 */
import type { GuideMatchup, GuideMatchupPayload } from "@/lib/guides/types";

const MATCHUP_RE = /^([ptz])v([ptz])$/i;

/** One published guide build a community build maps to. */
export interface CommunityGuideTarget {
  buildSlug: string;
  name: string;
}

/**
 * Canonical "PvZ" form of a community build's matchup, or null.
 *
 * Example: `communityGuideMatchup(" pvz ")` → "PvZ"; `communityGuideMatchup("PvX")` → null.
 */
export function communityGuideMatchup(raw: unknown): GuideMatchup | null {
  if (typeof raw !== "string") return null;
  const match = MATCHUP_RE.exec(raw.trim());
  if (!match) return null;
  return `${match[1].toUpperCase()}v${match[2].toUpperCase()}` as GuideMatchup;
}

function normalise(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text ? text : null;
}

/**
 * The published guide build whose catalog or display name exactly
 * matches one of the community build's names; null otherwise.
 *
 * Example: names ["stargate into glaives "] → `{ buildSlug: "stargate-into-glaives", … }`.
 */
export function findCommunityGuide(
  payload: Pick<GuideMatchupPayload, "openers">,
  names: ReadonlyArray<unknown>,
): CommunityGuideTarget | null {
  const wanted = new Set(names.map(normalise).filter((name): name is string => name !== null));
  if (wanted.size === 0) return null;
  const hit = payload.openers.find(
    (row) => row.published && (wanted.has(normalise(row.buildKey) ?? "") || wanted.has(normalise(row.name) ?? "")),
  );
  return hit ? { buildSlug: hit.buildSlug, name: hit.name } : null;
}
