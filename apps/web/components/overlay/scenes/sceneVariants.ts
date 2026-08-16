import { STREAM_BACKGROUND_IDS } from "@/lib/streamBackgrounds";
import type { OverlaySceneVariant } from "./OverlaySceneClient";

/** Public route allowlist kept outside Next's page-module export contract. */
export const VALID_SCENES = new Set<OverlaySceneVariant>([
  "between-games",
  "starting-soon",
  "brb",
  "intermission",
  "manual",
  ...STREAM_BACKGROUND_IDS,
]);

export function isValidScene(name: string): name is OverlaySceneVariant {
  return VALID_SCENES.has(name as OverlaySceneVariant);
}
