import { Trophy, Users } from "lucide-react";
import { Banner } from "@/components/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { CommunityShell } from "@/components/community/CommunityShell";
import { LeaderboardTab } from "@/components/community/LeaderboardTab";

export const metadata = {
  title: "Leaderboard — SC2 Tools",
  description:
    "Stock Market weekly P&L leaderboard. Players who opted into the public board, ranked by their weekly Arcade portfolio performance.",
};

export default function CommunityLeaderboardPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3 w-3" aria-hidden />
            Community
          </span>
        }
        title={
          <span className="inline-flex items-center gap-2">
            <Trophy className="h-6 w-6 text-warning" aria-hidden />
            Leaderboard
          </span>
        }
        description="Stock Market weekly P&L. Players who opted into the public board only — portfolios stay private."
      />

      <Banner variant="divider" />

      <CommunityShell active="leaderboard">
        <LeaderboardTab />
      </CommunityShell>
    </div>
  );
}
