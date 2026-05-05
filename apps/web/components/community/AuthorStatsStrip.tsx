import { BookMarked, Calendar } from "lucide-react";
import { StatCard } from "@/components/ui/Stat";
import { Icon } from "@/components/ui/Icon";
import { fmtAgo } from "@/lib/format";
import { coerceRace, raceIconName } from "@/lib/race";

export interface AuthorStatsStripProps {
  totalBuilds: number;
  totalVotes: number;
  primaryRace: string | null;
  joinedAt: string | null;
  topMatchup: string | null;
}

/**
 * AuthorStatsStrip — KPI row on the public author profile.
 *
 * 2-col on mobile, 4-col on tablet+. Stats stay readable at 375px.
 */
export function AuthorStatsStrip({
  totalBuilds,
  totalVotes,
  primaryRace,
  joinedAt,
  topMatchup,
}: AuthorStatsStripProps) {
  const race = primaryRace ? coerceRace(primaryRace) : null;
  const voteTone =
    totalVotes > 0
      ? "text-success"
      : totalVotes < 0
        ? "text-danger"
        : "text-text";
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        label="Builds published"
        value={totalBuilds.toLocaleString()}
        hint={
          <span className="inline-flex items-center gap-1">
            <BookMarked className="h-3 w-3" aria-hidden />
            Public library
          </span>
        }
      />
      <StatCard
        label="Net votes"
        value={
          <span className={voteTone}>
            {totalVotes > 0 ? "+" : ""}
            {totalVotes.toLocaleString()}
          </span>
        }
        hint="Across all builds"
      />
      <StatCard
        label="Primary race"
        value={
          race ? (
            <span className="inline-flex items-center gap-2">
              <Icon
                name={raceIconName(race)}
                kind="race"
                size={20}
                decorative
              />
              {race}
            </span>
          ) : (
            <span className="text-text-muted">Mixed</span>
          )
        }
        hint={topMatchup ? `Top matchup ${topMatchup}` : undefined}
      />
      <StatCard
        label="Member since"
        value={
          joinedAt ? (
            <span className="text-h3">{fmtAgo(joinedAt)}</span>
          ) : (
            <span className="text-text-muted">—</span>
          )
        }
        hint={
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" aria-hidden />
            First publish
          </span>
        }
      />
    </div>
  );
}
