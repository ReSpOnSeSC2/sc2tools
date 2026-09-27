/**
 * Guide → Ghost Build target. Turns a published build guide's community
 * median milestones into a practice target for the Ghost Build overlay
 * (lib/ghostBuild.ts), which the "Practice it on stream" CTA arms with
 * `armGhostTargetForMatchup` in a client island.
 *
 * Step names: the Ghost grader matches build-log names after
 * `normalizeGhostName` (a-z0-9 only), so steps must carry WIRE names
 * ("TwilightCouncil", "BlinkTech"), not display labels ("Blink"). The
 * payload milestone carries only `key`/`label`/`event`, so the step name
 * comes from `key`, the stable identifier in
 * apps/api/src/config/guideMilestones.js: repeated buildings carry an
 * occurrence suffix ("Nexus#2", "Hatchery#3"), stripped to the base wire
 * name. For every catalog entry that normalises to the same name as the
 * API's canonical `names[0]` (pinned by lib/guides/__tests__/ghost.test.ts).
 * Steps are ordered by median.
 *
 * Times are the RECORDED build-log medians (buildings at start,
 * morphs/upgrades at completion) — exactly what the grader compares
 * against — rounded to whole seconds; supply is unknown (null).
 *
 * Starting town hall: every replay logs the starting Nexus / Command
 * Center / Hatchery at 0:00, and the grader matches greedily in order.
 * When the earliest step is a later town hall (e.g. hatch-first
 * "Hatchery#2"), a 0:00 step for the starting town hall is prepended so
 * the grader does not pair the expansion target with the starting hall.
 */
import {
  GHOST_BUILD_VERSION,
  normalizeGhostTarget,
  type GhostConcreteRace,
  type GhostStep,
  type GhostTarget,
} from "@/lib/ghostBuild";
import type { GuideBuildPayload, GuideMatchup, GuideMilestone } from "@/lib/guides/types";

/** Fewer community milestones than this is not a meaningful target. */
export const GUIDE_GHOST_MIN_STEPS = 3;
/** Occurrence suffix on repeated-building milestone keys ("Nexus#2"). */
const OCCURRENCE_SUFFIX_RE = /#\d+$/;
const TOWN_HALL_WIRE_NAMES: ReadonlySet<string> = new Set([
  "Nexus",
  "CommandCenter",
  "Hatchery",
]);
const GAME_START_SEC = 0;
const MY_RACE_INDEX = 0;
const OPP_RACE_INDEX = 2;

interface OrderedMilestone {
  milestone: GuideMilestone;
  index: number;
}

/**
 * Base wire name of a milestone key.
 *
 * Example: `ghostStepName("Nexus#2")` → "Nexus"; `ghostStepName("BlinkTech")` → "BlinkTech".
 */
export function ghostStepName(key: string): string {
  return key.replace(OCCURRENCE_SUFFIX_RE, "").trim();
}

function hasOccurrenceSuffix(key: string): boolean {
  return OCCURRENCE_SUFFIX_RE.test(key);
}

function isUsableMilestone(milestone: GuideMilestone): boolean {
  return (
    typeof milestone.median === "number" &&
    Number.isFinite(milestone.median) &&
    milestone.median >= GAME_START_SEC &&
    ghostStepName(milestone.key).length > 0
  );
}

/** By median, then payload order (stable). */
function compareOrdered(a: OrderedMilestone, b: OrderedMilestone): number {
  return a.milestone.median - b.milestone.median || a.index - b.index;
}

function toStep(milestone: GuideMilestone): GhostStep {
  return { supply: null, t: Math.round(milestone.median), name: ghostStepName(milestone.key) };
}

function startingTownHallStep(first: GuideMilestone): GhostStep | null {
  const name = ghostStepName(first.key);
  if (!hasOccurrenceSuffix(first.key) || !TOWN_HALL_WIRE_NAMES.has(name)) return null;
  return { supply: null, t: GAME_START_SEC, name };
}

/**
 * Ghost Build target from a published guide's median milestones, or null
 * when unpublished, without timings, or with fewer than
 * {@link GUIDE_GHOST_MIN_STEPS} usable milestones.
 *
 * Example: for PvZ Stargate into Glaives with milestones Pylon 0:18,
 * Gateway 0:40, Nexus#2 1:24 → steps `Pylon@18, Gateway@40, Nexus@84`,
 * name "Stargate into Glaives (PvZ guide)".
 */
export function buildGhostTargetFromGuide(
  payload: GuideBuildPayload | null | undefined,
): GhostTarget | null {
  if (!payload || !payload.published || !payload.timings) return null;
  const ordered = payload.timings.milestones
    .map((milestone, index) => ({ milestone, index }))
    .filter((entry) => isUsableMilestone(entry.milestone))
    .sort(compareOrdered)
    .map((entry) => entry.milestone);
  if (ordered.length < GUIDE_GHOST_MIN_STEPS) return null;
  const anchor = startingTownHallStep(ordered[0]);
  const steps = [...(anchor ? [anchor] : []), ...ordered.map(toStep)];
  return normalizeGhostTarget({
    v: GHOST_BUILD_VERSION,
    name: `${payload.name} (${payload.matchup} guide)`,
    steps,
  });
}

/**
 * Concrete races for `armGhostTargetForMatchup(myRace, oppRace, target)`.
 *
 * Example: `ghostRacesForMatchup("PvZ")` → `{ myRace: "P", opponentRace: "Z" }`.
 */
export function ghostRacesForMatchup(matchup: GuideMatchup): {
  myRace: GhostConcreteRace;
  opponentRace: GhostConcreteRace;
} {
  return {
    myRace: toConcreteRace(matchup.charAt(MY_RACE_INDEX)),
    opponentRace: toConcreteRace(matchup.charAt(OPP_RACE_INDEX)),
  };
}

function toConcreteRace(letter: string): GhostConcreteRace {
  if (letter === "T") return "T";
  return letter === "Z" ? "Z" : "P";
}
