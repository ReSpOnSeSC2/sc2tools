import { apiFetch } from "@/lib/api";
import { AnalyzerShell } from "@/components/analyzer/AnalyzerShell";
import { SyncStatus } from "@/components/SyncStatus";
import { NoGamesYet } from "@/components/analyzer/EmptyStates";
import Link from "next/link";

type Me = {
  userId: string;
  source: string;
  games: { total: number; latest: string | null };
};

export default async function AnalyzerHome() {
  const meRes = await apiFetch<Me>("/v1/me");

  if (!meRes.ok) {
    return (
      <div className="card p-6">
        <h1 className="mb-2 text-2xl font-semibold">Analyzer</h1>
        <p className="text-danger">
          Could not reach the API ({meRes.status} {meRes.error}). Check
          NEXT_PUBLIC_API_BASE in your env, and that the API server is
          running.
        </p>
      </div>
    );
  }

  const noGames = meRes.data.games.total === 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Analyzer</h1>
          <SyncStatus
            total={meRes.data.games.total}
            latest={meRes.data.games.latest}
            userId={meRes.data.userId}
          />
        </div>
        <Link href="/download" className="btn btn-secondary">
          Get the agent
        </Link>
      </header>

      {noGames ? <NoGamesYet /> : <AnalyzerShell />}
    </div>
  );
}
