/**
 * Guide links for /definitions: for each definition, the published
 * community build guides that cover it, one per matchup. A matchup label
 * ("PvZ - …") has at most its own matchup; a race label ("Zerg - …") can
 * have one per matchup of that race. Only published pages are linked, so a
 * definition never points at an empty guide.
 */
import type { BuildDefinition } from "@/lib/build-definitions";
import { GUIDE_MATCHUPS, guideBuildPath, type GuideMatchup } from "@/lib/guides/slugs";

export interface DefinitionGuideLink {
  matchup: GuideMatchup;
  href: string;
}

/** Definition id → its published guide links (definitions without one are left out). */
export type DefinitionGuideLinks = Record<string, DefinitionGuideLink[]>;

/**
 * Example: with "/guides/pvz/stargate-into-glaives" published,
 * `definitionGuideLinks([pvzStargateIntoGlaives], published)` →
 * { "pvz-stargate-into-glaives": [{ matchup: "PvZ", href: "/guides/pvz/stargate-into-glaives" }] }.
 * An unknown published list (null: guides off or the API unreachable) links nothing.
 */
export function definitionGuideLinks(
  defs: ReadonlyArray<Pick<BuildDefinition, "id" | "name" | "race" | "matchup">>,
  published: ReadonlySet<string> | null,
): DefinitionGuideLinks {
  const links: DefinitionGuideLinks = {};
  if (!published || published.size === 0) return links;
  for (const def of defs) {
    const matchups = def.matchup
      ? [def.matchup]
      : GUIDE_MATCHUPS.filter((m) => m.charAt(0) === def.race.charAt(0));
    const found: DefinitionGuideLink[] = [];
    for (const matchup of matchups) {
      const href = guideBuildPath(matchup, def.name);
      if (href && published.has(href)) found.push({ matchup, href });
    }
    if (found.length > 0) links[def.id] = found;
  }
  return links;
}
