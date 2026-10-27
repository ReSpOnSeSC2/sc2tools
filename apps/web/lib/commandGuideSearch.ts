import {
  GUIDE_MATCHUPS, guideBuildOptions, guideBuildPath, guideCounterPath, guideDisplayName,
  guideMapPath, guideStrategyOptions, isGuideMatchup, type GuideMatchup, type GuideSlugOption,
} from "./guides/slugs";
import { commandQueryMatchup, type CommandSearchGroupId, type CommandSearchItem } from "./commandSearch";

export type CommandGuideMap = { readonly map: string; readonly slug: string };
export type CommandGuideCatalogOptions = {
  publishedPaths: ReadonlySet<string> | null;
  maps?: readonly CommandGuideMap[];
};
const UNPUBLISHED = "Not enough games yet";
const UNAVAILABLE = "Guide availability unavailable";
const RACE_NAMES: Readonly<Record<string, string>> = { P: "Protoss", T: "Terran", Z: "Zerg" };
const MAPS_MAX = 200;

/** Strict path grammar, never a URL/query/hash. Example: "/guides/pvz/counter/12-pool" -> true. */
export function isCommandGuidePath(path: string): boolean {
  if (path.trim() !== path) return false;
  return path === "/guides"
    || /^\/guides\/(?:maps\/[a-z0-9-]{1,80}|[ptz]v[ptz](?:\/(?:counter\/)?[a-z0-9-]{1,80})?)$/.test(path);
}

/** Viewer race stays first. Example: "zerg vs protoss" -> "ZvP". */
export function commandGuideQueryMatchup(query: string): GuideMatchup | null {
  const matchup = commandQueryMatchup(query);
  return isGuideMatchup(matchup) ? matchup : null;
}

function matchupTerms(matchup: GuideMatchup): string[] {
  return [matchup, `${RACE_NAMES[matchup[0]]} vs ${RACE_NAMES[matchup[2]]}`];
}

function publication(path: string, published: ReadonlySet<string> | null): {
  href?: string; disabled: boolean; reason: string;
} {
  if (published?.has(path)) return { href: path, disabled: false, reason: "" };
  return { disabled: true, reason: published === null ? UNAVAILABLE : UNPUBLISHED };
}

function guideItem(
  option: GuideSlugOption, matchup: GuideMatchup, kind: "opener" | "counter",
  published: ReadonlySet<string> | null,
): CommandSearchItem[] {
  const path = kind === "opener" ? guideBuildPath(matchup, option.name) : guideCounterPath(matchup, option.name);
  if (!path || !isCommandGuidePath(path)) return [];
  const state = publication(path, published);
  const terms = [option.name, ...matchupTerms(matchup)];
  if (kind === "counter") terms.push("how to beat", "counter");
  const group: CommandSearchGroupId = kind === "opener" ? "guide-openers" : "guide-counters";
  return [{
    id: `guide:${path}`, group, label: guideDisplayName(option.name), matchup, terms,
    description: state.reason || `${matchup} ${kind === "opener" ? "opener" : "counter guide"}`,
    ...(state.href ? { href: state.href } : {}), disabled: state.disabled,
  }];
}

function matchupItems(matchup: GuideMatchup, published: ReadonlySet<string> | null): CommandSearchItem[] {
  return [
    ...guideBuildOptions(matchup).flatMap(option => guideItem(option, matchup, "opener", published)),
    ...guideStrategyOptions(matchup).flatMap(option => guideItem(option, matchup, "counter", published)),
  ];
}

function mapItems(options: CommandGuideCatalogOptions): CommandSearchItem[] {
  const seen = new Set<string>();
  return (options.maps ?? []).slice(0, MAPS_MAX).flatMap(map => {
    if (!map.map.trim() || Array.from(map.map).length > 200 || /\p{Cc}/u.test(map.map)) return [];
    const path = guideMapPath(map.map);
    if (!path || path !== `/guides/maps/${map.slug}` || !isCommandGuidePath(path) || seen.has(path)) return [];
    seen.add(path);
    const state = publication(path, options.publishedPaths);
    return [{
      id: `guide:${path}`, group: "guide-maps" as const, label: map.map,
      description: state.reason || "Map guide", disabled: state.disabled,
      ...(state.href ? { href: state.href } : {}),
    }];
  });
}

/** No fetching/private corpus. Only positively published candidates link.
 * Example: createCommandGuideCatalog({ publishedPaths }). */
export function createCommandGuideCatalog(options: CommandGuideCatalogOptions): CommandSearchItem[] {
  return [...GUIDE_MATCHUPS.flatMap(matchup => matchupItems(matchup, options.publishedPaths)), ...mapItems(options)];
}
