import names from "./definition-names.generated.json";

/** The catalog's stable anchor spelling, shared without importing its prose. */
export function definitionId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"];
const canonicalNames = [...names.map(([name]) => name), ...MATCHUPS.map((matchup) => `${matchup} - Game Too Short`)];
const exact = new Map<string, string>(canonicalNames.map((name) => [name.toLowerCase(), name]));
for (const [name, alias] of names) if (alias) exact.set(alias.toLowerCase(), name);

/** Link only verified labels; matchup-prefixed race-generic labels retain their owning race. */
export function definitionHref(label: string): string | null {
  const clean = label.trim();
  let name = exact.get(clean.toLowerCase());
  if (!name) {
    const prefixed = /^([PTZ])v[PTZ]\s*-\s*(.+)$/i.exec(clean);
    if (prefixed) {
      const race = ({ P: "Protoss", T: "Terran", Z: "Zerg" } as const)[prefixed[1].toUpperCase() as "P" | "T" | "Z"];
      name = exact.get(`${race} - ${prefixed[2]}`.toLowerCase());
    }
  }
  return name ? `/definitions#${definitionId(name)}` : null;
}
