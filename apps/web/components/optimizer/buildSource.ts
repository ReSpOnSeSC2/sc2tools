/**
 * Shared "what gets adapted" contract between the build adapter's
 * source panels (My games / Upload replay / Saved builds) and the
 * page orchestrator. Every source carries its own race + matchup —
 * the replay or saved build knows what it is, so the page never asks.
 */
import type {
  BuildOrderEvent,
  BuildRuleLike,
  BuildSignatureItem,
} from "@/lib/build-events";
import type { SimRace } from "@/lib/optimizer/types";

export type BuildSource =
  | {
      /** A saved build from the user's custom builds library. */
      type: "custom";
      id: string;
      name: string;
      race: SimRace;
      vsRace?: string;
      signature?: BuildSignatureItem[];
      rules?: BuildRuleLike[];
    }
  | {
      /**
       * A parsed game — from the user's replay library
       * (/v1/games/:id/build-order) or a one-off upload
       * (/v1/public/preview-replay). Events keep replay order, so
       * the adaptation preserves exactly what the player did.
       */
      type: "replay";
      id: string;
      name: string;
      race: SimRace;
      vsRace?: string;
      events: BuildOrderEvent[];
    };

/**
 * Replay metadata stores races as full names ("Protoss") or single
 * letters ("P"); the simulator only handles the three playable races.
 * Returns null for Random/unknown so callers can surface a clear
 * error instead of simulating nonsense.
 */
export function coerceSimRace(raw: unknown): SimRace | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "protoss" || normalized === "p") return "Protoss";
  if (normalized === "terran" || normalized === "t") return "Terran";
  if (normalized === "zerg" || normalized === "z") return "Zerg";
  return null;
}
