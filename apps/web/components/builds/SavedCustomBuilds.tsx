"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import { coerceRace, coerceVsRace, matchupLabel } from "@/lib/race";
import type { CustomBuild } from "./types";

type ListResponse = {
  items: CustomBuild[];
  total?: number | null;
  limit?: number | null;
  truncated?: boolean;
};

/** Saved definitions include opponent builds and builds without replay tags. */
export function SavedCustomBuilds() {
  const { data, error, isValidating, mutate } = useApi<ListResponse>("/v1/custom-builds");
  const items = data?.items ?? [];

  return (
    <Card aria-label="Your custom builds" title="Your custom builds" right={
      <Link href="/builds" className="inline-flex min-h-11 items-center gap-1 text-caption font-semibold text-accent hover:underline">
        Manage library <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden />
      </Link>
    }>
      <p className="mb-3 text-caption text-text-muted">
        All your saved builds, including opponent builds and builds with no matched replays.
        Game filters apply to replay performance below.
      </p>
      {error ? (
        <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 text-caption text-danger">
          <p>{data ? "Couldn't refresh your custom builds. Showing the last loaded library." : "Couldn't load your custom builds."}</p>
          <Button size="sm" variant="secondary" loading={isValidating} onClick={() => void mutate().catch(() => undefined)}>
            Retry
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <Skeleton rows={2} />
      ) : items.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((build) => (
            <li key={build.slug} className="min-w-0">
              <Link
                href={`/builds/${encodeURIComponent(build.slug)}`}
                className="flex h-full min-h-11 flex-col gap-2 rounded-lg border border-line p-3 transition-colors hover:border-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="break-words text-sm font-semibold text-text">{build.name}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" variant="neutral">
                    {matchupLabel(coerceRace(build.race), coerceVsRace(build.vsRace))}
                  </Badge>
                  <Badge size="sm" variant={build.perspective === "opponent" ? "cyan" : "neutral"}>
                    {build.perspective === "opponent" ? "From opponent" : "Your build"}
                  </Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : !error ? (
        <p className="text-caption text-text-muted">
          No custom builds saved yet. Save a build from a replay or create one in your library.
        </p>
      ) : null}
      {data?.truncated ? (
        <p className="mt-3 text-caption text-text-muted">
          Showing the newest {items.length.toLocaleString()} of {(data.total ?? items.length).toLocaleString()} saved builds.
          Manage your library to review its limit.
        </p>
      ) : null}
    </Card>
  );
}
