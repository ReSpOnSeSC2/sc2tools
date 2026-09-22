export type SiteStats = {
  agentDownloads: number | null;
  activeAgents: number | null;
  activeUsers: number | null;
  generatedAt: string;
  activityWindowSeconds: number;
};

/** Keep unavailable data distinct from a measured zero, on both sides of the proxy. */
export function parseSiteStats(value: unknown): SiteStats {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid site statistics");
  }
  const data = value as Record<string, unknown>;
  const isCount = (count: unknown): count is number | null =>
    count === null ||
    (typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
  if (
    !isCount(data.agentDownloads) ||
    !isCount(data.activeAgents) ||
    !isCount(data.activeUsers) ||
    typeof data.generatedAt !== "string" ||
    data.generatedAt.length > 64 ||
    !Number.isFinite(Date.parse(data.generatedAt)) ||
    typeof data.activityWindowSeconds !== "number" ||
    !Number.isSafeInteger(data.activityWindowSeconds) ||
    data.activityWindowSeconds <= 0 ||
    data.activityWindowSeconds > 3_600
  ) {
    throw new Error("Invalid site statistics");
  }
  return {
    agentDownloads: data.agentDownloads,
    activeAgents: data.activeAgents,
    activeUsers: data.activeUsers,
    generatedAt: data.generatedAt,
    activityWindowSeconds: data.activityWindowSeconds,
  };
}

export async function fetchSiteStats(url = "/api/site/stats"): Promise<SiteStats> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Site statistics are temporarily unavailable");
  return parseSiteStats(await response.json());
}
