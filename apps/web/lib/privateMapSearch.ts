import { privateCommandHref, safeText, type PrivateCommandChoice, type PrivateSearchGroup, type PrivateSearchMap } from "./privateCommandSearch";

// Personal maps in quick search (ADR 0069, 2026-11-01 amendment): the existing
// owner-scoped GET /v1/maps, read once and filtered in the browser. The query
// never reaches a request; only map names and game counts are kept.
export const PRIVATE_MAP_CATALOG_PATH = "/v1/maps";
export const PRIVATE_MAP_CATALOG_ROWS = 2_000;
export const PRIVATE_MAP_SEARCH_TIMEOUT_MS = 10_000;
const MAP_RESULTS_MAX = 8;
// The API's placeholder for a game without a map name; nothing can find it by name.
const UNNAMED_MAP = "Unknown";

export type PrivateMapCatalog = Readonly<
  | { status: "ready"; rows: readonly Readonly<{ map: string; total: number }>[]; partial: boolean }
  | { status: "unavailable"; reason: "invalid_data" | "source_budget_exceeded" }
>;

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value as unknown : undefined;
}

/**
 * The /v1/maps rows a name search can use. Each row is read for its own `name`
 * and `total` only. Rows without a usable name are skipped; a malformed name or
 * count marks the catalog partial. More than 2,000 rows is too large to admit.
 */
export function decodePrivateMapCatalog(value: unknown): PrivateMapCatalog {
  if (!Array.isArray(value)) return Object.freeze({ status: "unavailable", reason: "invalid_data" });
  if (value.length > PRIVATE_MAP_CATALOG_ROWS) return Object.freeze({ status: "unavailable", reason: "source_budget_exceeded" });
  const totals = new Map<string, number>();
  let partial = false;
  for (let index = 0; index < value.length; index += 1) {
    const row: unknown = Object.hasOwn(value, index) ? ownValue(value, String(index)) : undefined;
    if (!row || typeof row !== "object" || Array.isArray(row)) { partial = true; continue; }
    const name = ownValue(row, "name"), total = ownValue(row, "total");
    if (typeof name !== "string" || !name || name === UNNAMED_MAP) continue;
    if (!safeText(name, 200) || typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) { partial = true; continue; }
    totals.set(name, Math.max(total, totals.get(name) ?? 0));
  }
  const rows = Object.freeze([...totals].map(([map, total]) => Object.freeze({ map, total })));
  return Object.freeze({ status: "ready", rows, partial });
}

// Mongo's simple collation compares UTF-8 bytes; ties sort the same way here.
function byteOrder(left: string, right: string): number {
  const encoder = new TextEncoder(), a = encoder.encode(left), b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/**
 * Maps whose name starts with the literal query, ignoring case by Unicode simple
 * case folding, most games first, at most eight. `query` is privateCommandQuery's
 * output. Example: "alc" finds "Alcyone LE"; "LE" does not.
 */
export function privateMapSearchGroup(catalog: PrivateMapCatalog, query: string): PrivateSearchGroup<PrivateSearchMap> {
  if (catalog.status === "unavailable") {
    return Object.freeze({ status: "unavailable", items: Object.freeze([]) as readonly [], hasMore: null, reason: catalog.reason });
  }
  const prefix = new RegExp(`^${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
  const matches = catalog.rows.filter(row => prefix.test(row.map))
    .sort((left, right) => right.total - left.total || byteOrder(left.map, right.map));
  return Object.freeze({ status: "ready", hasMore: matches.length > MAP_RESULTS_MAX,
    items: Object.freeze(matches.slice(0, MAP_RESULTS_MAX).map(row => Object.freeze({ map: row.map }))) });
}

/** Rows link to the Maps page focused on each name through privateCommandHref. */
export function privateMapChoices(group: PrivateSearchGroup<PrivateSearchMap>): readonly PrivateCommandChoice[] {
  if (group.status !== "ready") return Object.freeze([]);
  return Object.freeze(group.items.map(item => {
    const target = Object.freeze({ kind: "map" as const, map: item.map });
    return Object.freeze({ group: "maps" as const, label: item.map, target, href: privateCommandHref(target) });
  }));
}
