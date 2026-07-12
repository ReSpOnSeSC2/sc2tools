import type { LiveGameEnvelope } from "@/components/overlay/types";
import { normalizeConcreteGhostRace } from "@/lib/ghostBuild";

export type ConcreteGhostRace = NonNullable<
  ReturnType<typeof normalizeConcreteGhostRace>
>;

export interface ResolvedGhostLiveRaces {
  ownRace: ConcreteGhostRace | null;
  opponentRace: ConcreteGhostRace | null;
  /** A direct Random signal always wins over concrete history fallbacks. */
  opponentIsRandom: boolean;
  /** There are only nine concrete slots; playing Random has no slot. */
  ownRaceIsRandom: boolean;
}

/**
 * Resolve the two races used by the Ghost 3x3 matrix from an agent live
 * envelope. Direct `/game` players and the bridge's opponent block win;
 * enriched history is only a fallback when the current envelope does not
 * carry a concrete value. A direct Random value is deliberately sticky at
 * the caller and must never be replaced with a historical concrete race.
 */
export function resolveGhostLiveRaces(
  liveGame: LiveGameEnvelope | null | undefined,
): ResolvedGhostLiveRaces {
  if (!liveGame) {
    return {
      ownRace: null,
      opponentRace: null,
      opponentIsRandom: false,
      ownRaceIsRandom: false,
    };
  }

  const players = (liveGame.players ?? []).filter(
    (player) => String(player?.type ?? "").toLowerCase() !== "computer",
  );
  const userName = normalizePlayerName(liveGame.user?.name);
  const opponentName = normalizePlayerName(liveGame.opponent?.name);

  const ownPlayer =
    (userName
      ? players.find((player) => normalizePlayerName(player.name) === userName)
      : undefined)
    ?? (opponentName
      ? players.find(
          (player) => normalizePlayerName(player.name) !== opponentName,
        )
      : undefined)
    ?? players[0]
    ?? null;

  const opponentPlayer =
    (opponentName
      ? players.find(
          (player) => normalizePlayerName(player.name) === opponentName,
        )
      : undefined)
    ?? players.find((player) => player !== ownPlayer)
    ?? null;

  const directOwn = nonBlankRaceValues([
    liveGame.user?.race,
    ownPlayer?.race,
  ]);
  const ownRaceIsRandom = directOwn.some(isRandomRace);
  const ownRace = ownRaceIsRandom
    ? null
    : directOwn.length > 0
      ? firstConcreteRace(directOwn)
      : normalizeConcreteGhostRace(liveGame.streamerHistory?.myRace);

  const directOpponent = nonBlankRaceValues([
    liveGame.opponent?.race,
    opponentPlayer?.race,
  ]);
  const opponentIsRandom = directOpponent.some(isRandomRace)
    || (directOpponent.length === 0
      && isRandomRace(liveGame.streamerHistory?.oppRace));
  const opponentRace = opponentIsRandom
    ? null
    : directOpponent.length > 0
      ? firstConcreteRace(directOpponent)
      : normalizeConcreteGhostRace(liveGame.streamerHistory?.oppRace);

  return { ownRace, opponentRace, opponentIsRandom, ownRaceIsRandom };
}

function firstConcreteRace(
  values: ReadonlyArray<string>,
): ConcreteGhostRace | null {
  for (const value of values) {
    const race = normalizeConcreteGhostRace(value);
    if (race) return race;
  }
  return null;
}

function nonBlankRaceValues(
  values: ReadonlyArray<unknown>,
): string[] {
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isRandomRace(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "r" || normalized.startsWith("random");
}

function normalizePlayerName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}
