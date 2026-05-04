"use client";

import { useApi } from "@/lib/clientApi";

type Opponent = {
  pulseId: string;
  displayNameSample: string;
  race: string;
  gameCount: number;
  wins: number;
  losses: number;
  lastSeen: string;
};

type ListResponse = {
  items: Opponent[];
  nextBefore: string | null;
};

export function OpponentsList() {
  const { data, error, isLoading } = useApi<ListResponse>("/v1/opponents");

  if (isLoading) return <SkeletonList />;
  if (error) {
    return (
      <p className="card p-6 text-danger">
        Failed to load opponents: {error.message}
      </p>
    );
  }
  if (!data || data.items.length === 0) {
    return <p className="card p-6 text-text-muted">No opponents yet.</p>;
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-elevated text-left text-text-muted">
          <tr>
            <th className="px-4 py-3 font-medium">Opponent</th>
            <th className="px-4 py-3 font-medium">Race</th>
            <th className="px-4 py-3 font-medium">Games</th>
            <th className="px-4 py-3 font-medium">W&ndash;L</th>
            <th className="px-4 py-3 font-medium">Win&nbsp;%</th>
            <th className="px-4 py-3 font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((o) => {
            const winPct =
              o.gameCount > 0 ? Math.round((100 * o.wins) / o.gameCount) : null;
            return (
              <tr key={o.pulseId} className="border-t border-border">
                <td className="px-4 py-3">
                  {o.displayNameSample || (
                    <span className="text-text-dim">unknown</span>
                  )}
                </td>
                <td className="px-4 py-3">{o.race || "—"}</td>
                <td className="px-4 py-3 font-mono">{o.gameCount}</td>
                <td className="px-4 py-3 font-mono">
                  {o.wins}&ndash;{o.losses}
                </td>
                <td className="px-4 py-3 font-mono">
                  {winPct === null ? "—" : `${winPct}%`}
                </td>
                <td className="px-4 py-3 text-text-muted">
                  {new Date(o.lastSeen).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="card divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex animate-pulse gap-4 p-4">
          <div className="h-4 w-32 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-12 rounded bg-bg-elevated" />
          <div className="h-4 w-24 rounded bg-bg-elevated" />
        </div>
      ))}
    </div>
  );
}
