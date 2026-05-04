import Link from "next/link";
import { notFound } from "next/navigation";
import { getJson } from "@/lib/serverApi";
import { CommunityBuildActions } from "@/components/CommunityBuildActions";

type Build = {
  slug: string;
  title: string;
  description: string;
  matchup?: string;
  authorName?: string;
  votes: number;
  publishedAt: string;
  build?: {
    name?: string;
    matchup?: string;
    notes?: string;
    steps?: Array<{ supply?: number; time?: string; action?: string }>;
  };
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getJson<Build>(
    `/v1/community/builds/${encodeURIComponent(slug)}`,
  );
  if (!data) return { title: "Build not found — SC2 Tools" };
  return {
    title: `${data.title} — community build — SC2 Tools`,
    description:
      data.description?.slice(0, 200) ||
      `Player-published StarCraft II build for ${data.matchup || "any matchup"}.`,
  };
}

export default async function CommunityBuildPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getJson<Build>(
    `/v1/community/builds/${encodeURIComponent(slug)}`,
  );
  if (!data) notFound();

  const steps = data.build?.steps || [];

  return (
    <article className="space-y-6">
      <Link
        href="/community"
        className="text-xs uppercase tracking-wider text-text-muted hover:text-text"
      >
        ← back to community
      </Link>

      <header className="space-y-2">
        <h1 className="text-3xl font-bold">{data.title}</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
          {data.matchup && (
            <span className="rounded bg-bg-elevated px-2 py-1 font-mono">
              {data.matchup}
            </span>
          )}
          {data.authorName && <span>by {data.authorName}</span>}
          <span className="font-mono">
            {data.votes >= 0 ? "▲" : "▼"} {Math.abs(data.votes)}
          </span>
        </div>
      </header>

      {data.description && (
        <section className="card p-5">
          <p className="whitespace-pre-line text-sm leading-relaxed">
            {data.description}
          </p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Build order</h2>
        {steps.length === 0 ? (
          <p className="card p-5 text-text-muted">
            This build doesn&apos;t include a structured step list.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated text-left text-text-muted">
              <tr>
                <th className="px-3 py-2">Supply</th>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-1 font-mono">{s.supply ?? ""}</td>
                  <td className="px-3 py-1 font-mono">{s.time ?? ""}</td>
                  <td className="px-3 py-1">{s.action ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <CommunityBuildActions slug={slug} />
    </article>
  );
}
