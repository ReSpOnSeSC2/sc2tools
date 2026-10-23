import { wrColor } from "@/lib/format";
import type { OwnerBuildRecord } from "./useOwnerBuilds";

export function CommunityBuildRecord({ record }: { record: OwnerBuildRecord }) {
  const decided = record.wins + record.losses;
  if (!record.total) return <span className="text-micro text-text-muted">No games with this build yet</span>;
  return <span className="text-micro tabular-nums text-text-muted">{record.total} {record.total === 1 ? "game" : "games"} · {record.wins}–{record.losses}{decided ? <span style={{ color: wrColor(record.wins / decided, decided) }}> · {Math.round(record.wins / decided * 100)}%</span> : null}</span>;
}
