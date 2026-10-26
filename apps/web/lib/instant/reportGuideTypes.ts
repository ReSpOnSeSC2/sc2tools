export interface ReportGuideLink { name: string; matchup: string; kind: "build" | "counter"; href: string; key: string }
export interface ReportGuideFocus { name: string; matchup: string; key: string }
export interface TryGuideProps { guideLinks?: ReportGuideLink[]; guideFocus?: ReportGuideFocus | null }

/** Explicit URL intent only. Unknown, repeated and noncanonical keys fail closed. */
export function reportGuideFocus(value: unknown, links: ReadonlyArray<ReportGuideLink>): ReportGuideFocus | null {
  if (typeof value !== "string" || value.length > 150 || !/^[ptz]v[ptz]\/[a-z0-9][a-z0-9-]*$/.test(value)) return null;
  const match = links.find((link) => link.kind === "build" && link.key === value);
  return match ? { name: match.name, matchup: match.matchup, key: match.key } : null;
}

export function tryFocusHref(matchup: string, build: string): string | null {
  const key = `${matchup}/${build}`;
  if (key.length > 150 || !/^[ptz]v[ptz]\/[a-z0-9][a-z0-9-]*$/.test(key)) return null;
  return `/try?focus=${encodeURIComponent(key)}&utm_source=guide&utm_medium=link&utm_campaign=instant`;
}
