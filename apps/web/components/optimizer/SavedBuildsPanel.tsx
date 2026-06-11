"use client";

/**
 * "Saved builds" source panel: the user's custom builds library —
 * legacy signature builds and modern rules-based (v3 editor) builds
 * alike. Adapt one, or "Adapt & save all" to write a re-timed copy
 * of every adaptable library build back into the library in one pass.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, CopyPlus } from "lucide-react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import type { BuildRuleLike, BuildSignatureItem } from "@/lib/build-events";
import type { VsRace } from "@/lib/race";
import {
  CUSTOM_BUILD_PUT_PATH,
  toCustomBuildPayload,
} from "@/lib/optimizer/export/toCustomBuild";
import type { AdaptResult } from "@/lib/optimizer/types";
import { coerceSimRace, type BuildSource } from "./buildSource";

interface CustomBuildListItem {
  slug: string;
  name: string;
  race?: string;
  vsRace?: string;
  signature?: BuildSignatureItem[];
  rules?: BuildRuleLike[];
}

function hasSteps(item: CustomBuildListItem): boolean {
  return (
    (Array.isArray(item.signature) && item.signature.length > 0) ||
    (Array.isArray(item.rules) && item.rules.length > 0)
  );
}

function toSource(item: CustomBuildListItem): BuildSource | null {
  const race = coerceSimRace(item.race);
  if (!race) return null;
  return {
    type: "custom",
    id: item.slug,
    name: item.name,
    race,
    vsRace: item.vsRace,
    signature: item.signature,
    rules: item.rules,
  };
}

export function SavedBuildsPanel({
  toProfileId,
  onAdapt,
  adaptSource,
}: {
  /** Target patch id — used to name bulk-saved copies. */
  toProfileId: string;
  onAdapt: (source: BuildSource) => void;
  /** Pure adaptation used by the bulk save (throws on bad builds). */
  adaptSource: (source: BuildSource) => AdaptResult;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [query, setQuery] = useState("");
  const [bulkState, setBulkState] = useState<{
    running: boolean;
    done: number;
    total: number;
  }>({ running: false, done: 0, total: 0 });
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data } = useApi<{ items: CustomBuildListItem[] }>(
    "/v1/custom-builds",
  );

  const builds = useMemo(
    () =>
      (data?.items ?? []).filter(
        (item) => hasSteps(item) && coerceSimRace(item.race) !== null,
      ),
    [data],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? builds.filter((b) =>
          `${b.name} ${b.race ?? ""} ${b.vsRace ?? ""}`
            .toLowerCase()
            .includes(q),
        )
      : builds;
    return [...list].sort(
      (a, b) =>
        (a.race ?? "").localeCompare(b.race ?? "") ||
        a.name.localeCompare(b.name),
    );
  }, [builds, query]);

  const selected = builds.find((b) => b.slug === selectedSlug) ?? null;
  const selectedSource = selected ? toSource(selected) : null;

  const handleAdaptAll = async () => {
    if (bulkState.running || builds.length === 0) return;
    setBulkState({ running: true, done: 0, total: builds.length });
    let saved = 0;
    const failures: string[] = [];
    for (const build of builds) {
      try {
        const source = toSource(build);
        if (!source) throw new Error("unknown race");
        const result = adaptSource(source);
        const validVs: VsRace[] = [
          "Protoss",
          "Terran",
          "Zerg",
          "Random",
          "Any",
        ];
        const buildVs = validVs.includes(build.vsRace as VsRace)
          ? (build.vsRace as VsRace)
          : "Any";
        const payload = toCustomBuildPayload(result, {
          name: `${build.name} (${toProfileId})`,
          vsRace: buildVs,
          description: `Re-timed from "${build.name}" for patch ${toProfileId}.`,
        });
        await apiCall<void>(getToken, CUSTOM_BUILD_PUT_PATH(payload.slug), {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        saved += 1;
      } catch {
        failures.push(build.name);
      }
      setBulkState((s) => ({ ...s, done: s.done + 1 }));
    }
    setBulkState({ running: false, done: 0, total: 0 });
    if (saved > 0) {
      toast.success(`Saved ${saved} adapted build${saved === 1 ? "" : "s"}`, {
        description: `Each as "name (${toProfileId})" in your library.`,
      });
    }
    if (failures.length > 0) {
      toast.error(`Couldn't adapt ${failures.length}`, {
        description: failures.slice(0, 4).join(", "),
      });
    }
  };

  return (
    <div className="space-y-3">
      <SignedIn>
        <div className="flex items-center justify-between gap-2">
          <Input
            inputSize="sm"
            type="search"
            placeholder="Search saved builds…"
            aria-label="Search saved builds"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1"
          />
          {builds.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              loading={bulkState.running}
              onClick={handleAdaptAll}
              iconLeft={<CopyPlus className="h-3.5 w-3.5" />}
            >
              {bulkState.running
                ? `Adapting ${bulkState.done}/${bulkState.total}…`
                : "Adapt & save all"}
            </Button>
          ) : null}
        </div>
        {builds.length === 0 ? (
          <EmptyState
            title="No adaptable saved builds"
            sub="Builds from your library with step data (signature or rules) appear here."
          />
        ) : (
          <ul
            className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1"
            role="radiogroup"
            aria-label="Saved builds"
          >
            {filtered.map((build) => {
              const isSelected = selectedSlug === build.slug;
              const race = coerceSimRace(build.race);
              const stepCount =
                build.signature?.length ?? build.rules?.length ?? 0;
              return (
                <li key={build.slug}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedSlug(build.slug)}
                    className={[
                      "flex w-full items-center gap-2 rounded-lg border-2 p-3 text-left transition-colors",
                      isSelected
                        ? "border-line bg-accent/10 shadow-hard"
                        : "border-line/25 bg-bg-surface hover:border-line/60",
                    ].join(" ")}
                  >
                    {race ? (
                      <Icon
                        name={race.toLowerCase()}
                        kind="race"
                        size="sm"
                        decorative
                      />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold text-text">
                        {build.name}
                      </span>
                      <span className="block text-caption text-text-dim">
                        {stepCount} steps
                        {build.signature?.length ? "" : " (from rules)"}
                      </span>
                    </span>
                    {build.vsRace && build.vsRace !== "Any" ? (
                      <Badge variant="neutral" size="sm">
                        vs {build.vsRace}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <Button
          disabled={!selectedSource}
          onClick={() => selectedSource && onAdapt(selectedSource)}
          iconLeft={<ArrowRightLeft className="h-4 w-4" />}
        >
          Adapt this build
        </Button>
        <p className="text-caption text-text-dim">
          Manage your library on the{" "}
          <Link href="/builds" className="text-accent hover:underline">
            builds page
          </Link>
          .
        </p>
      </SignedIn>
      <SignedOut>
        <EmptyState
          title="Sign in to adapt your saved builds"
          sub="Your custom builds library syncs across devices once you're signed in."
        />
      </SignedOut>
    </div>
  );
}
