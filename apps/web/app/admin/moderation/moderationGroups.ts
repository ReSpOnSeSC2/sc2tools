export type Report = {
  id: string;
  reporterUserId: string;
  targetType: "build" | "opponent" | "review_request" | "review_comment";
  targetId: string;
  reason: string;
  note?: string;
  createdAt: string;
  target?: { title: string; snippet: string; href?: string; link?: string; hidden: boolean; status: string } | null;
};

export type ReportGroup = { key: string; reports: Report[]; oldest: number; newest: number; tally: string };
export const TARGET_LABEL: Record<Report["targetType"], string> = {
  build: "Community build", opponent: "Opponent profile", review_request: "Review request", review_comment: "Review comment",
};

export function groupReports(items: Report[]): ReportGroup[] {
  const groups = new Map<string, Report[]>();
  for (const item of items) {
    const key = `${item.targetType}:${item.targetId}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return [...groups].map(([key, reports]) => {
    const counts = new Map<string, number>();
    for (const report of reports) counts.set(report.reason, (counts.get(report.reason) ?? 0) + 1);
    return { key, reports, oldest: Math.min(...reports.map((r) => Date.parse(r.createdAt))), newest: Math.max(...reports.map((r) => Date.parse(r.createdAt))),
      tally: [...counts].map(([reason, count]) => `${reason} ×${count}`).join(", ") };
  });
}

export function targetHref(report: Report): string | null {
  if (report.targetType === "build") return `/community/builds/${encodeURIComponent(report.targetId)}`;
  if (report.targetType === "opponent") return `/community/opponents/${encodeURIComponent(report.targetId)}`;
  return report.target?.link ?? report.target?.href ?? null;
}

export function consequence(report: Report): string {
  if (report.targetType === "build") return "Unpublishes the build from Community.";
  if (report.targetType === "opponent") return "Removes this opponent profile from the public community view.";
  return "Takes it down for good; the author loses 20 review karma.";
}
