import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { fmtDay } from "@/lib/format";
import { coerceRace, coerceVsRace, raceIconName } from "@/lib/race";
import { SKILL_LEVELS } from "@/lib/build-rules";
import type { CommunityBuildDetail } from "./types";

export function CommunityBuildMeta({ data, ruleCount, stepCount }: { data: CommunityBuildDetail; ruleCount: number | null; stepCount: number }) {
  const build = data.build ?? {};
  const race = coerceRace(build.race ?? data.matchup?.[0]);
  const opponent = coerceVsRace(build.vsRace ?? data.matchup?.split("v")[1]);
  const skill = SKILL_LEVELS.find((level) => level.id === build.skillLevel);
  const row = "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1";
  return <Card><dl aria-label="Build details" className="space-y-3 text-caption">
    <div className={row}><dt className="text-text-muted">Matchup</dt><dd className="inline-flex flex-wrap items-center gap-1.5 font-medium text-text"><Icon name={raceIconName(race)} kind="race" size={14} decorative />{race} <span className="font-normal text-text-muted">vs</span> {opponent !== "Any" ? <Icon name={raceIconName(opponent)} kind="race" size={14} decorative /> : null}{opponent}</dd></div>
    <div className={row}><dt className="text-text-muted">Type</dt><dd className="font-medium text-text">{build.perspective === "opponent" ? "Opponent build to scout" : "Build to play"}</dd></div>
    <div className={row}><dt className="text-text-muted">Rules</dt><dd className="font-medium text-text">{ruleCount === null ? `${stepCount} step${stepCount === 1 ? "" : "s"}` : `${ruleCount} rule${ruleCount === 1 ? "" : "s"}`}</dd></div>
    <div className={row}><dt className="text-text-muted">Skill level</dt><dd>{skill ? <Badge size="sm" variant="neutral">{skill.label}</Badge> : "Any level"}</dd></div>
    <div className={row}><dt className="text-text-muted">Published</dt><dd className="font-medium text-text">{fmtDay(data.publishedAt)}</dd></div>
    <div className={row}><dt className="text-text-muted">Updated</dt><dd className="font-medium text-text">{fmtDay(data.updatedAt || data.publishedAt)}</dd></div>
  </dl></Card>;
}
