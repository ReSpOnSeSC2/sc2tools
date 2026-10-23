import { cache } from "react";
import { currentSeasonPresetId, resolvePreset } from "@/lib/datePresets";
import type { PublicReplayQuery } from "./archiveQuery";

const requestTime = cache(() => new Date());

/** Server-only rolling dates are resolved once per render, never stored in links. */
export function archiveRequestQuery(query: PublicReplayQuery, paginate = true): string {
  const params = paginate ? new URLSearchParams({ limit: "25", sort: query.sort || "date_desc" }) : new URLSearchParams();
  for (const key of ["search", "result", "matchup", "map", "build"] as const) if (query[key]) params.set(key, query[key]!);
  if (query.range) {
    const now = requestTime();
    const range = query.range === "season" ? resolvePreset(currentSeasonPresetId()) : { since: new Date(now.getTime() - (query.range === "7d" ? 7 : 30) * 86_400_000), until: now };
    if (range.since) params.set("since", range.since.toISOString());
    if (range.until) params.set("until", range.until.toISOString());
  }
  if (paginate && query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}
