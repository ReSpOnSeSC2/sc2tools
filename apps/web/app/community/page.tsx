import Link from "next/link";
import { getJson } from "@/lib/serverApi";
import { Banner } from "@/components/Banner";

export const metadata = {
  title: "Community builds — SC2 Tools",
  description:
    "Player-published StarCraft II build orders, ranked by community votes.",
};

type Build = {
  slug: string;
  title: string;
  description: string;
  matchup?: string;
  authorName?: string;
  votes: number;
  publishedAt: string;
};

export default async function CommunityPage({
  searchParams,
}: {
  searchParams: Promise<{ matchup?: string }>;
}) {
  const sp = await searchParams;
  const qs = sp.matchup ? `?matchup=${encodeURIComponent(sp.matchup)}` : "";
  const data = await getJson<{ items: Build[] }>(`/v1/community/builds${qs}`);
  const items = data?.items || [];
  const matchups = ["PvT", "PvZ", "PvP", "TvP", "TvZ", "TvT", "ZvP", "ZvT", "ZvZ"];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Community builds</h1>
        <p className="text-text-muted">
          Builds published by SC2 Tools players. Sign in to publish your own
          or vote.
        </p>
      </header>

      <Banner variant="divider" />

      <nav className="flex flex-wrap gap-2 text-sm">
        <Link
          href="/community"
          className={`btn ${!sp.matchup ? "" : "btn-secondary"}`}
        >
          All
        </Link>
        {matchups.map((m) => (
          <Link
            key={m}
            href={`/community?matchup=${m}`}
            className={`btn ${sp.matchup === m ? "" : "btn-secondary"}`}
          >
            {m}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="card p-6 text-text-muted">
          No published builds yet.
          {sp.matchup ? ` Try a different matchup.` : ` Be the first!`}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((b) => (
            <li key={b.slug} className="card p-5">
              <Link href={`/community/builds/${b.slug}`} className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-lg font-semibold text-accent">
                    {b.title}
                  </h2>
                  <span className="font-mono text-sm tabular-nums text-text-muted">
                    {b.votes >= 0 ? "▲" : "▼"} {Math.abs(b.votes)}
                  </span>
                </div>
                <div className="text-xs uppercase tracking-wide text-text-dim">
                  {b.matchup || "any matchup"}
                  {b.authorName ? ` · ${b.authorName}` : ""}
                </div>
                {b.description && (
                  <p className="text-sm text-text-muted">
                    {b.description.slice(0, 240)}
                    {b.description.length > 240 ? "…" : ""}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
