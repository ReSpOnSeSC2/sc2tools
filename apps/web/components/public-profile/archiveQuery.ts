export interface PublicReplayQuery {
  search?: string;
  result?: "win" | "loss" | "tie";
  matchup?: string;
  map?: string;
  range?: "7d" | "30d" | "season";
  build?: string;
  sort?: "date_desc" | "date_asc";
  cursor?: string;
  page?: number;
  notice?: "page-expired";
}

type RawQuery = Record<string, unknown>;
const text = (raw: unknown, max: number) => typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) || undefined : undefined;

/** The archive URL is a bounded allowlist, shared by server forms and links. */
export function parseArchiveQuery(raw: RawQuery): PublicReplayQuery {
  const read = (key: string, max = 512) => text(Array.isArray(raw[key]) ? raw[key][0] : raw[key], max);
  const result = read("result"); const matchup = read("matchup"); const range = read("range"); const page = read("page");
  return {
    search: read("search", 100),
    result: result === "win" || result === "loss" || result === "tie" ? result : undefined,
    matchup: /^[PTZR]v[PTZR]$/.test(matchup || "") ? matchup : undefined,
    map: read("map", 64), range: range === "7d" || range === "30d" || range === "season" ? range : undefined,
    build: read("build", 120), sort: read("sort") === "date_asc" ? "date_asc" : "date_desc",
    cursor: read("cursor"), page: page && /^\d{1,4}$/.test(page) && Number(page) >= 1 && Number(page) <= 1000 ? Number(page) : undefined,
    notice: read("notice") === "page-expired" ? "page-expired" : undefined,
  };
}

/** Overrides with undefined remove a key. One-time notices never propagate. */
export function archiveHref(root: string, query: PublicReplayQuery, overrides: Partial<PublicReplayQuery> = {}): string {
  const next = { ...query, ...overrides }; const params = new URLSearchParams();
  for (const key of ["search", "result", "matchup", "map", "range", "build", "sort", "cursor", "page"] as const) {
    const value = next[key];
    if (value !== undefined && value !== "" && !(key === "sort" && value === "date_desc")) params.set(key, String(value));
  }
  return params.size ? `${root}?${params}` : root;
}

export function archiveFilterLabels(query: PublicReplayQuery) {
  const labels: Array<{ key: keyof PublicReplayQuery; label: string }> = [];
  if (query.matchup) labels.push({ key: "matchup", label: query.matchup });
  if (query.result) labels.push({ key: "result", label: { win: "Wins", loss: "Losses", tie: "Ties" }[query.result] });
  if (query.search) labels.push({ key: "search", label: `“${query.search}”` });
  if (query.map) labels.push({ key: "map", label: `Map: ${query.map}` });
  if (query.range) labels.push({ key: "range", label: { "7d": "Last 7 days", "30d": "Last 30 days", season: "This season" }[query.range] });
  if (query.build) labels.push({ key: "build", label: `Build: ${query.build}` });
  if (query.sort === "date_asc") labels.push({ key: "sort", label: "Oldest first" });
  return labels;
}
