import presenceRules from "@/lib/overlayPresenceRules.json";
import type { OverlaySceneVariant } from "./OverlaySceneClient";

/** Public route allowlist kept outside Next's page-module export contract. */
export const VALID_SCENES = new Set<OverlaySceneVariant>(presenceRules.scenes as OverlaySceneVariant[]);

export function isValidScene(name: string): name is OverlaySceneVariant {
  return VALID_SCENES.has(name as OverlaySceneVariant);
}
