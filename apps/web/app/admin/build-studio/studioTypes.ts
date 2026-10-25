export type Scope = "preset" | "custom" | "community";
export type JsonObject = Record<string, unknown>;
export interface BuildRow {
  id: string; name: string; scope: Scope; owner: string | null; mode: string;
  sourceSlug?: string; surfaces?: Array<"you" | "opponent">; removed?: boolean; replaced?: boolean; race?: string;
}
export interface PolicyCondition {
  kind: "count" | "exists" | "order" | "first";
  category: "building" | "unit" | "upgrade"; clock: "start" | "completion" | "recorded";
  name?: string; names?: string[]; beforeSeconds?: number; min?: number; max?: number; proxy?: true; allowTies?: boolean;
}
export interface PresetEntry {
  name: string; priority: number; enabled: boolean; mode?: "released" | "replacement";
  anyOf: PolicyCondition[][]; description?: string;
  steps?: Array<{ timeSeconds: number; action: string; supply?: number }>;
}
export interface Policy { schemaVersion: number; evaluatorVersion: number; revision: number; hash: string; entries: PresetEntry[] }
export interface BuildDetail extends BuildRow {
  truncated?: boolean; definitionCounts?: Record<string, number>; build?: JsonObject; title?: string; description?: string; revision?: number;
  history?: Array<{ revision: number; savedAt: string; build: JsonObject; title?: string | null; description?: string | null }>;
  released?: { description: string; implementation: string; surfaces?: Array<"you" | "opponent">; releasedCriteria?: PolicyCondition[][] };
  replacement?: PresetEntry | null; expectedHash?: string; policyRevision?: number; releaseHash?: string;
  evaluatorVersion?: number; schemaVersion?: number; source?: string;
}
export const STUDIO_ROOT = "/v1/admin/build-studio";
export const resource = (scope: Scope, id: string) => `${STUDIO_ROOT}/${scope}/${encodeURIComponent(id)}`;
export const json = (value: unknown) => JSON.stringify(value, null, 2);
export function defaultEntry(detail: BuildDetail): PresetEntry {
  return detail.replacement || { name: detail.id, priority: 100, enabled: true, mode: "released", anyOf: [], description: detail.released?.description || "", steps: [] };
}
export function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "status" in error && error.status === 409) return "This definition changed or its owner is busy. Your draft is preserved. Reload the latest definition before reviewing again.";
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "The request failed. Your draft is preserved; try again.";
}
