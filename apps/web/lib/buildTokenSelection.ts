import { getBuildToken, type BuildTokenRace } from "./buildTokens";

/** Editor-only validation; shared structural readers keep unknown stored data
 * visible for correction instead of silently dropping a persisted rule. */
export function buildTokenError(value: string, race?: string): string | null {
  if (!value) return "Choose a unit, building or upgrade from the list.";
  const token = getBuildToken(value);
  if (!token) return "Unknown action. Choose a unit, building or upgrade from the list.";
  if (["Protoss", "Terran", "Zerg"].includes(race || "") && token.race !== race) return `This action belongs to ${token.race}. Choose an action for ${race}, or change the build's race.`;
  return null;
}
export const buildTokenFitsRace = (value: string, race?: string): boolean => buildTokenError(value, race) === null;
export const pickerRace = (race?: string): BuildTokenRace | null => ["Protoss", "Terran", "Zerg"].includes(race || "") ? race as BuildTokenRace : null;
