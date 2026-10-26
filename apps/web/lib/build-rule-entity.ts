/** Display-only names shared by the editor and broadcast scouting card.
 * Keep this dependency-free: labels do not need rule/reference validation. */
const VERB_PREFIX_RE = /^(Build|Train|Research|Morph)(?=[A-Za-z])/;
const ENTITY_OVERRIDES: Readonly<Record<string, string>> = {
  adeptpiercingattack: "Resonating Glaives",
  resonatingglaives: "Resonating Glaives",
  lurkermp: "Lurker",
  swarmhostmp: "Swarm Host",
  vikingfighter: "Viking",
  helliontank: "Hellbat",
  blinktech: "Blink",
  shieldwall: "Combat Shield",
  punishergrenades: "Concussive Shells",
  warpgateresearch: "Warp Gate",
  zerglingmovementspeed: "Metabolic Boost",
  zerglingattackspeed: "Adrenal Glands",
  overlordspeed: "Pneumatized Carapace",
};

/**
 * Display name for a rule token: strip the stored verb, apply in-game
 * overrides and space camelCase/trailing digits. Preserve unknown legacy
 * text and punctuation; never change the stored token.
 */
export function humanizeRuleEntity(name: string): string {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const stripped = raw.replace(VERB_PREFIX_RE, "");
  const normalized = stripped.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const override = ENTITY_OVERRIDES[normalized];
  if (override) return override;
  return (stripped.charAt(0).toUpperCase() + stripped.slice(1))
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
}
