import { apiCall, boundedApiRequest } from "./clientApi";
import { writeSynced } from "./ghostSyncIO";
import { referenceOrderPracticeTarget, referencePracticeTarget, replayOrderTarget, ruleCheckpointTarget } from "./practiceTarget";
import { buildGhostTargetFromGuide } from "./guides/ghost";
import { normalizeConcreteGhostRace } from "./ghostBuild";
import type { GuideBuildPayload } from "./guides/types";
import type { GhostMatchupKey, GhostTarget } from "./ghostBuild";

export interface PracticeSource {
  name: string;
  slug?: string;
  race?: string;
  vsRace?: string;
  sourceGameId?: string;
  perspective?: "you" | "opponent";
  rules?: unknown;
  buildOrder?: unknown;
  hasReferenceBuildOrder?: boolean;
}
export interface PracticeInput {
  build: PracticeSource;
  target?: GhostTarget | null;
  guideHref?: string;
  privateBuild?: boolean;
}
type Reference = { buildKey: string; matchup: string; side: string; target: unknown };

/** Called only by an explicit Practice action. Never fans out per card. A
 * failed reference lookup is surfaced; it must not silently select a lower
 * priority source during an outage. No public snapshot can name a private
 * source replay; that path is restricted to the owner's saved-build UI. */
export async function resolvePracticeTarget(input: PracticeInput, matchup: GhostMatchupKey, getToken: () => Promise<string | null>, signal: AbortSignal) {
  let reference = input.build.buildOrder;
  if (!reference && input.privateBuild && input.build.slug && input.build.hasReferenceBuildOrder) {
    const current = await apiCall<PracticeSource>(getToken, `/v1/custom-builds/${encodeURIComponent(input.build.slug)}`, { signal });
    if (!current || current.race !== "Random" && normalizeConcreteGhostRace(current.race) !== matchup[0] || (current.perspective ?? "you") !== (input.build.perspective ?? "you")) throw new Error("This build changed. Refresh the library before choosing a practice target.");
    reference = current.buildOrder;
  }
  const supplied = referenceOrderPracticeTarget(input.build.name, reference, matchup[0]);
  if (supplied) return { target: supplied, source: "Supplied reference build order — timed known actions only" };
  if (input.privateBuild) {
    const references = await apiCall<{ references?: Record<string, Reference> }>(getToken, "/v1/me/ghost-builds", { signal });
    const buildKey = input.build.slug || input.build.name;
    const rows = Object.values(references.references ?? {}).filter(row => row.buildKey === buildKey && row.side === (input.build.perspective ?? "you") && row.matchup[0] === matchup[0]);
    const reference = rows.find(row => row.matchup === matchup) ?? rows.sort((a, b) => a.matchup.localeCompare(b.matchup))[0];
    const selected = referencePracticeTarget(reference?.target);
    if (selected) return { target: selected, source: "Saved reference build order" };
  }
  // Public snapshot slugs are the author's private namespace. They must not
  // accidentally select an unrelated same-slug reference in the viewer's account.
  if (input.target) {
    const target = referencePracticeTarget(input.target);
    if (target) return { target, source: "Guide community-median checkpoints" };
  }
  if (input.guideHref && /^\/guides\/(pvp|pvt|pvz|tvp|tvt|tvz|zvp|zvt|zvz)\/[a-z0-9-]{1,80}$/.test(input.guideHref)) {
    const guide = await apiCall<GuideBuildPayload>(getToken, `/v1${input.guideHref}`, { signal });
    const target = buildGhostTargetFromGuide(guide);
    if (target) return { target, source: "Guide community-median checkpoints" };
  }
  if (input.privateBuild && input.build.sourceGameId) {
    try {
      const order = await apiCall<{ events?: unknown; opp_events?: unknown; my_race?: unknown; opp_race?: unknown }>(getToken, `/v1/games/${encodeURIComponent(input.build.sourceGameId)}/build-order`, { signal });
      const otherSide = input.build.perspective === "opponent";
      // A saved definition's race can be edited after capture. An old replay
      // must not silently coach a different faction in the newly chosen slot.
      const ownRace = normalizeConcreteGhostRace(otherSide ? order.opp_race : order.my_race);
      const target = ownRace === matchup[0] ? replayOrderTarget(input.build.name, otherSide ? order.opp_events : order.events, input.build.sourceGameId) : null;
      if (target) return { target, source: "Source replay build order" };
    } catch (error) {
      if (!error || typeof error !== "object" || !("status" in error) || error.status !== 404) throw error;
    }
  }
  const target = ruleCheckpointTarget(input.build.name, input.build.rules);
  if (target) return { target, source: "Rule deadlines — checkpoints, not recorded build times" };
  throw new Error("No timed practice steps are available. Save a reference replay with a build order, or add positive timed rules first.");
}

export async function assignPractice(input: PracticeInput, matchup: GhostMatchupKey, getToken: () => Promise<string | null>, signal: AbortSignal) {
  return boundedApiRequest(async boundedSignal => {
    const selected = await resolvePracticeTarget(input, matchup, getToken, boundedSignal);
    boundedSignal.throwIfAborted();
    const config = await writeSynced(getToken, { matchup, target: selected.target }, boundedSignal);
    return { ...selected, config };
  }, 20_000, signal);
}
