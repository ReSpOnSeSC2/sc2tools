import { apiFetch } from "@/lib/api";
import { OpponentsList } from "@/components/OpponentsList";
import { SyncStatus } from "@/components/SyncStatus";
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

      {noGames ? <FirstRunCard /> : <OpponentsList />}
    </div>
  );
}

function FirstRunCard() {
  return (
    <div className="card space-y-3 p-6">
      <h2 className="text-lg font-semibold">No games yet</h2>
      <p className="text-text-muted">
        Install the SC2 Tools Agent on your gaming PC. It watches your
        Replays folder and streams every finished game here in seconds.
      </p>
      <ol className="list-decimal space-y-1 pl-6 text-text-muted">
        <li>
          <Link href="/download">Download the agent</Link>
        </li>
        <li>
          Open <Link href="/devices">Devices</Link> to pair it.
        </li>
        <li>Play a ranked game. This page updates live.</li>
      </ol>
    </div>
  );
}
