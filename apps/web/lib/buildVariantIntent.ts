import generatedIds from "./buildVariantIds.generated.json";
const ids = new Set<string>(generatedIds);

/** Small enough for auth helpers; never imports the full catalog/prose. */
export function knownBuildVariantId(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,160}$/.test(value) && ids.has(value) ? value : null;
}
/** The public auth continuation accepts exactly this one catalog identity. */
export function publicBuildVariantIntent(params: Pick<URLSearchParams, "keys" | "get" | "getAll">): string | null {
  return [...params.keys()].length === 1 && params.getAll("variant").length === 1 ? knownBuildVariantId(params.get("variant")) : null;
}
export function buildVariantContinuationHref(id: string): string {
  const known = knownBuildVariantId(id);
  return known ? `/definitions?variant=${known}` : "/definitions";
}
