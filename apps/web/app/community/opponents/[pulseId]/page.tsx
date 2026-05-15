import Link from "next/link";
import { getJson } from "@/lib/serverApi";

type Aggregate = {
  pulseId: string;
  race?: string;
  contributors: number;
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  openings: Record<string, number>;
  strategies: Record<string, number>;
  byMap: Record<string, { wins: number; losses: number }>;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pulseId: string }>;
}) {
  const { pulseId } = await params;
  return {
    title: `Opponent profile · ${pulseId} — SC2 Tools community`,
    description:
      "Aggregated cross-player stats for a StarCraft II opponent. Names withheld; results k-anonymous.",
    robots: { index: true, follow: true },
  };
}

export default async function CommunityOpponentPage({
  params,
}: {
  params: Promise<{ pulseId: string }>;
}) {
  const { pulseId } = await params;
  const data = await getJson<Aggregate>(
    `/v1/community/opponents/${encodeURIComponent(pulseId)}`,
  );

  if (!data) {
    return (
      <article className="space-y-4">
        <Link href="/community" className="text-xs text-text-muted">
          ← back to community
        </Link>
        <h1 className="text-2xl font-bold">Not enough data</h1>
        <p className="card p-5 text-text-muted">
          We only publish aggregated profiles when at least 5 distinct SC2
          Tools users have faced this opponent. Below that threshold there
          isn&apos;t enough data to anonymise responsibly.
        </p>
      </article>
    );
  }

  const sortedOpenings = Object.entries(data.openings).sort(
    (a, b) => b[1] - a[1],
  );
  const sortedStrategies = Object.entries(data.strategies).sort(
    (a, b) => b[1] - a[1],
  );
  const mapEntries = Object.entries(data.byMap).map(([map, v]) => ({
    map,
    ...v,
    total: v.wins + v.losses,
    winRate: v.wins + v.losses > 0 ? v.wins / (v.wins + v.losses) : 0,
  }));

  return (
    <article className="space-y-6">
      <Link
        href="/community"
        className="text-xs uppercase tracking-wider text-text-muted hover:text-text"
      >
        ← back to community
      </Link>

      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Opponent · {data.pulseId}</h1>
        <p className="text-text-muted">
          Aggregated across {data.contributors} contributing players.
          Battle-tag withheld for privacy.
        </p>
        {data.race ? (
          <div className="pt-1">
            <Link
              href={`/snapshots/trends?matchup=${encodeURIComponent(matchupAgainst(data.race))}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-caption font-semibold text-accent hover:bg-accent/20"
            >
              Snapshot patterns vs this race →
            </Link>
          </div>
        ) : null}
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Race" value={data.race || "—"} />
        <Stat label="Games" value={String(data.games)} />
        <Stat label="W–L (their POV)" value={`${data.wins}–${data.losses}`} />
        <Stat label="Win rate" value={`${(data.winRate * 100).toFixed(1)}%`} />
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card title="Most-shown openings">
          {sortedOpenings.length === 0 ? (
            <p className="text-text-muted">None tagged yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sortedOpenings.slice(0, 8).map(([k, v]) => (
                <li key={k} className="flex justify-between">
                  <span>{k}</span>
                  <span className="font-mono text-text-muted">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Strategies seen">
          {sortedStrategies.length === 0 ? (
            <p className="text-text-muted">None tagged yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sortedStrategies.slice(0, 8).map(([k, v]) => (
                <li key={k} className="flex justify-between">
                  <span>{k}</span>
                  <span className="font-mono text-text-muted">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <Card title="Map breakdown">
          {mapEntries.length === 0 ? (
            <p className="text-text-muted">No map data yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-bg-elevated text-text-muted">
                <tr>
                  <th className="px-3 py-1 text-left">Map</th>
                  <th className="px-3 py-1 text-right">W</th>
                  <th className="px-3 py-1 text-right">L</th>
                  <th className="px-3 py-1 text-right">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {mapEntries.map((m) => (
                  <tr key={m.map} className="border-t border-border">
                    <td className="px-3 py-1">{m.map}</td>
                    <td className="px-3 py-1 text-right font-mono text-success">
                      {m.wins}
                    </td>
                    <td className="px-3 py-1 text-right font-mono text-danger">
                      {m.losses}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {(m.winRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </article>
  );
}

function matchupAgainst(oppRace: string): string {
  const head = String(oppRace || "?").trim().charAt(0).toUpperCase();
  // Trends takes a matchup filter; the caller picks a fixed "their race"
  // and lets the trends API span all of the player's own races. We
  // default the my-race side to the same letter (mirror matchup) so the
  // URL is always valid; the trends page lets the user override.
  const oppLetter = "PTZ".includes(head) ? head : "Z";
  return `${oppLetter}v${oppLetter}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs uppercase tracking-wide text-text-dim">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card space-y-2 p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {children}
    </div>
  );
}
