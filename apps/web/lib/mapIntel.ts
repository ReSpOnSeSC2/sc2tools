/**
 * Map Intel — the private spatial heatmaps of one map.
 *
 * The API (/v1/spatial/<layer>, services/spatial.js) bins the latest 300
 * games with map data into a grid over the map's playable bounds. This module
 * holds what the panel needs to ask for a layer and to place it on the map:
 *
 *   - world → stage projection: the layout image is stretched to the playable
 *     bounds and the stage keeps their aspect ratio, so a world position maps
 *     linearly with Y flipped — exactly MapReplayer's ``worldProjection`` with
 *     no padding (lib/__tests__/mapIntel.test.ts pins both per map);
 *   - grid cell → stage rectangle, with rows counted from the bottom edge as
 *     the API bins them;
 *   - the sample caption and the hot-zone labels the text list reads.
 *
 * No I/O; deterministic.
 */

export type MapIntelLayer = "opp-proxies" | "battle" | "death-zone" | "buildings";

export interface MapIntelLayerSpec {
  id: MapIntelLayer;
  label: string;
  /** /v1/spatial/<route> */
  route: string;
  /** Plural noun for captions: "Fights in 12 of 30 analysed games". */
  noun: string;
  description: string;
  /** Heat hue as RGB, one hue per layer (the stage is the dark map in both themes). */
  rgb: readonly [number, number, number];
}

export const MAP_INTEL_LAYERS: readonly MapIntelLayerSpec[] = [
  { id: "opp-proxies", label: "Their proxies", route: "opponent-proxies", noun: "Proxies", description: "Structures your opponent built away from their main base.", rgb: [255, 84, 84] },
  { id: "battle", label: "Fights", route: "battle", noun: "Fights", description: "Where the big army engagements happened.", rgb: [255, 176, 32] },
  { id: "death-zone", label: "Where you lose units", route: "death-zone", noun: "Lost fights", description: "Fights where you lost more army value than your opponent.", rgb: [255, 92, 214] },
  { id: "buildings", label: "Your buildings", route: "buildings", noun: "Your buildings", description: "Where you placed your own structures.", rgb: [60, 224, 214] },
];

export function mapIntelLayer(id: MapIntelLayer): MapIntelLayerSpec {
  return MAP_INTEL_LAYERS.find((layer) => layer.id === id) ?? MAP_INTEL_LAYERS[0];
}

const LAYER_BY_KIND: Readonly<Record<string, MapIntelLayer>> = { opp_proxy: "opp-proxies", battle: "battle", death: "death-zone", buildings: "buildings" };

/** The layer an API answer belongs to (its ``kind``), so a stale answer is never labelled as the layer being loaded. */
export function layerForKind(kind: string): MapIntelLayer | null {
  return LAYER_BY_KIND[kind] ?? null;
}

/** Grid the panel requests: 48 cells across a ladder map is ~3.5 world units a cell. */
export const MAP_INTEL_GRID = 48;

export interface MapIntelBounds { minX: number; minY: number; maxX: number; maxY: number }
export interface MapIntelCell { x: number; y: number; value: number; intensity: number; games: number }
export interface MapIntelZone {
  x: number;
  y: number;
  /** Share of the layer's weight inside the zone, 0–1. */
  share: number;
  /** Distinct games with a position inside the zone. */
  games: number;
  base: "main" | "natural" | "third" | null;
  /** "top left", "centre", "right"… */
  area: string;
}
export interface MapIntelResponse {
  ok: boolean;
  kind: string;
  map: string;
  grid: number;
  bounds: MapIntelBounds | null;
  points: number;
  /** Games that placed at least one position on this layer. */
  games: number;
  /** Games read: the latest ones with map data, at most ``maxGames``. */
  scanned: number;
  capped: boolean;
  maxGames: number;
  minGames: number;
  belowMinimum: boolean;
  cells: MapIntelCell[];
  zones: MapIntelZone[];
}

export interface MapIntelQuery {
  /** Exact edition names of this map ("Alcyone", "Alcyone LE"). */
  aliases?: readonly string[];
  /** The page's filter query ("?since=…&race=P"), from filtersToQuery or buildProfileQuery. */
  filterQuery?: string;
  /** A dossier opponent: their games only. */
  opponent?: string | null;
  mergeLinked?: boolean;
  /** "P" | "T" | "Z" narrows to one opponent race. */
  oppRace?: string | null;
}

/**
 * Request path of one layer. The page's filters are kept; the map, the
 * alias cohort, the grid and the opponent are this panel's own.
 *
 * Example: `mapIntelPath("battle", "Goldenaura", { filterQuery: "?race=P" })`
 * → "/v1/spatial/battle?race=P&map=Goldenaura&grid=48".
 */
export function mapIntelPath(layer: MapIntelLayer, map: string, query: MapIntelQuery = {}): string {
  const params = new URLSearchParams((query.filterQuery ?? "").replace(/^\?/, ""));
  params.delete("map_exact_label");
  params.set("map", map);
  const aliases = [...new Set([map, ...(query.aliases ?? [])].filter(Boolean))];
  if (aliases.length > 1) params.set("map_exact", JSON.stringify(aliases));
  else params.delete("map_exact");
  params.set("grid", String(MAP_INTEL_GRID));
  if (query.oppRace) params.set("opp_race", query.oppRace);
  if (query.opponent) {
    params.set("opponent", query.opponent);
    if (query.mergeLinked) params.set("mergeLinked", "1");
    else params.delete("mergeLinked");
  }
  return `/v1/spatial/${mapIntelLayer(layer).route}?${params}`;
}

/**
 * Stage position (px) of a world position. The stage has the bounds' aspect
 * ratio and the layout image fills it, so this equals MapReplayer's
 * ``projectX``/``projectY`` with zero padding.
 */
export function worldToStage(bounds: MapIntelBounds, width: number, height: number, x: number, y: number): { left: number; top: number } {
  return {
    left: ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * width,
    top: ((bounds.maxY - y) / (bounds.maxY - bounds.minY)) * height,
  };
}

/** Stage rectangle (px) of a grid cell. Row 0 is the bottom edge of the map. */
export function cellRect(cell: { x: number; y: number }, grid: number, width: number, height: number) {
  const w = width / grid;
  const h = height / grid;
  return { left: cell.x * w, top: (grid - 1 - cell.y) * h, width: w, height: h };
}

/** Width over height of the playable area; the stage's CSS aspect ratio. */
export function stageAspect(bounds: MapIntelBounds): number {
  return (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
}

const BASE_NAMES = { main: "Main base", natural: "Natural", third: "Third base" } as const;

/** A hot zone in words: "Natural, top left" or "Centre of the map". */
export function zoneLabel(zone: Pick<MapIntelZone, "base" | "area">): string {
  const area = zone.area || "centre";
  if (zone.base) return `${BASE_NAMES[zone.base]}, ${area}`;
  return `${area.charAt(0).toUpperCase()}${area.slice(1)} of the map`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Fights in 12 of the latest 300 analysed games" — what the heat is made of. */
export function sampleCaption(response: Pick<MapIntelResponse, "games" | "scanned" | "capped" | "maxGames">, layer: MapIntelLayer): string {
  const of = response.capped ? `of the latest ${response.maxGames}` : `of ${response.scanned}`;
  return `${mapIntelLayer(layer).noun} in ${response.games} ${of} analysed ${response.scanned === 1 && !response.capped ? "game" : "games"}`;
}

/** Why a layer is withheld: below its minimum sample. */
export function belowMinimumText(response: Pick<MapIntelResponse, "games" | "minGames">, layer: MapIntelLayer): string {
  return `Not enough games to show a pattern yet: ${mapIntelLayer(layer).noun.toLowerCase()} in ${plural(response.games, "game")}, ${response.minGames} needed.`;
}

/** One hot-zone line: "31% · seen in 12 games". */
export function zoneDetail(zone: Pick<MapIntelZone, "share" | "games">): string {
  return `${Math.round(zone.share * 100)}% · seen in ${plural(zone.games, "game")}`;
}

/** Heat alpha for a cell: square-root scaled so faint cells stay visible next to a hot spot. */
export function heatAlpha(intensity: number, opacity: number): number {
  const clamped = Math.min(1, Math.max(0, intensity));
  return Math.min(1, Math.max(0, opacity)) * (0.18 + 0.82 * Math.sqrt(clamped));
}
