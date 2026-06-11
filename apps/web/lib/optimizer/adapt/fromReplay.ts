/**
 * Replay → adapter bridge: convert the per-game build-order events
 * (returned by /v1/games/:id/build-order, or reconstructed from the
 * public preview's build_log) into the ordered action list the adapt
 * engine consumes.
 *
 * Unlike the signature path (which compresses to per-unit counts and
 * loses interleaving), this preserves the replay's exact step order —
 * a game's 3rd gateway stays between the robo and the twilight, where
 * the player actually put it. Workers are dropped automatically (the
 * simulator's macro policies own worker production per patch), and a
 * cutoff keeps the adaptation focused on the opening rather than a
 * 20-minute game's full production tab.
 */
import {
  normalizeBuildEvents,
  type BuildOrderEvent,
} from "@/lib/build-events";
import type { PatchProfile } from "../types";
import { actionsFromSteps, type ResolvedActions } from "./adapt";

/**
 * Resolve replay events into adapter actions, keeping replay order.
 *
 * @param cutoffSec Only events starting at or before this second are
 *   adapted (the "heart" of the build). Pass `undefined` for the
 *   whole game.
 */
export function actionsFromReplayEvents(
  profile: PatchProfile,
  events: ReadonlyArray<BuildOrderEvent>,
  cutoffSec?: number,
): ResolvedActions {
  const rows = normalizeBuildEvents(events)
    .filter((row) => Number.isFinite(row.time) && row.time >= 0)
    .filter((row) => cutoffSec === undefined || row.time <= cutoffSec)
    .sort((a, b) => a.time - b.time);
  // The icon-resolved name is already lowercase-canonical ("gateway",
  // "cyberneticscore"); fall back to the raw tracker name, which the
  // adapter's case-insensitive index + alias table can still resolve.
  const steps = rows.map((row) => row.iconName ?? row.rawName);
  const resolved = actionsFromSteps(profile, steps);
  return {
    ...resolved,
    latestMilestoneSec: rows.length > 0 ? rows[rows.length - 1].time : 0,
  };
}
