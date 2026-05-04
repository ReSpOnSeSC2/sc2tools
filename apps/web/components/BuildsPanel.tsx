"use client";

import { useApi } from "@/lib/clientApi";

type Build = {
  slug: string;
  name: string;
  race: string;
  vsRace?: string;
  description?: string;
  updatedAt?: string;
};

type ListResponse = { items: Build[] };

export function BuildsPanel() {
  const { data, error, isLoading } = useApi<ListResponse>("/v1/custom-builds");

  if (isLoading) return <p className="text-text-muted">Loading…</p>;
  if (error) return <p className="text-danger">Failed: {error.message}</p>;
  if (!data || data.items.length === 0) {
    return (
      <p className="card p-6 text-text-muted">
        No custom builds yet. The agent will sync any local custom_builds.json
        on first run.
      </p>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {data.items.map((b) => (
        <article key={b.slug} className="card space-y-1 p-5">
          <h3 className="text-lg font-semibold">{b.name}</h3>
          <p className="text-sm text-text-muted">
            {b.race}
            {b.vsRace ? ` vs ${b.vsRace}` : ""}
            {b.updatedAt
              ? ` · updated ${new Date(b.updatedAt).toLocaleDateString()}`
              : ""}
          </p>
          {b.description && (
            <p className="text-sm text-text-muted">{b.description}</p>
          )}
        </article>
      ))}
    </div>
  );
}
