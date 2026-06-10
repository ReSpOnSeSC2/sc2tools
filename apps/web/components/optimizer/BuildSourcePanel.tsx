"use client";

/**
 * Reference build picker: shipped standard 12-worker openers for the
 * selected race, plus ALL of the user's saved custom builds — both
 * legacy signature builds and modern rules-based (v3 editor) builds.
 * The selected build is what gets re-timed for the target patch, and
 * "Adapt & save all" writes a re-timed copy of every library build
 * back into the library in one pass.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRightLeft, CopyPlus } from "lucide-react";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import type { BuildRuleLike, BuildSignatureItem } from "@/lib/build-events";
import { matchupLabel, type VsRace } from "@/lib/race";
import {
  CUSTOM_BUILD_PUT_PATH,
  toCustomBuildPayload,
} from "@/lib/optimizer/export/toCustomBuild";
import type {
  AdaptResult,
  ReferenceBuild,
  SimRace,
} from "@/lib/optimizer/types";

export type BuildSource =
  | {
      type: "standard";
      id: string;
      name: string;
      steps: string[];
      /** Patch the build was designed for (skips 12-worker baseline). */
      native?: string;
    }
  | {
      type: "custom";
      id: string;
      name: string;
      signature?: BuildSignatureItem[];
      rules?: BuildRuleLike[];
      vsRace?: string;
    };

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

export function BuildSourcePanel({
  race,
  vsRace,
  profileId,
  references,
  error,
  onAdapt,
  adaptSource,
}: {
  race: SimRace;
  vsRace: SimRace;
  profileId: string;
  references: ReferenceBuild[];
  error: string | null;
  onAdapt: (source: BuildSource) => void;
  /** Pure adaptation used by the bulk save (throws on bad builds). */
  adaptSource: (source: BuildSource) => AdaptResult;
}) {
  const [selected, setSelected] = useState<string>("");
  const [query, setQuery] = useState("");
  const [showOtherMatchups, setShowOtherMatchups] = useState(false);
  const [bulkState, setBulkState] = useState<{
    running: boolean;
    done: number;
    total: number;
  }>({ running: false, done: 0, total: 0 });
  const { getToken } = useAuth();
  const { toast } = useToast();
  const { data: customData } = useApi<{ items: CustomBuildListItem[] }>(
    "/v1/custom-builds",
  );
  const matchup = matchupLabel(race, vsRace);

  const customBuilds = useMemo(
    () =>
      (customData?.items ?? []).filter(
        (item) => item.race === race && hasSteps(item),
      ),
    [customData, race],
  );

  const toSource = (build: CustomBuildListItem): BuildSource => ({
    type: "custom",
    id: build.slug,
    name: build.name,
    signature: build.signature,
    rules: build.rules,
    vsRace: build.vsRace,
  });

  const sources = useMemo<Map<string, BuildSource>>(() => {
    const map = new Map<string, BuildSource>();
    for (const ref of references) {
      map.set(`standard:${ref.id}`, {
        type: "standard",
        id: ref.id,
        name: ref.name,
        steps: ref.steps,
        native: ref.native,
      });
    }
    for (const build of customBuilds) {
      map.set(`custom:${build.slug}`, toSource(build));
    }
    return map;
  }, [references, customBuilds]);

  const selectedSource = sources.get(selected) ?? null;

  // Current-matchup builds first, then the rest alphabetically — with
  // every /definitions opener covered, the list is long. Search also
  // matches the DEFINITION names a build covers ("Phoenix into Robo"
  // finds the build covering pvt-phoenix-into-robo even if its card
  // wears a different title).
  const definitionNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const def of BUILD_DEFINITIONS) map.set(def.id, def.name);
    return map;
  }, []);
  const sortedReferences = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...references]
      .filter((ref) => {
        // Only the selected matchup's builds by default; searching or
        // the "show more" expander widens to the whole race catalog.
        if (!q && !showOtherMatchups && !ref.matchups.includes(matchup)) {
          return false;
        }
        if (!q) return true;
        const covered = (ref.definitionIds ?? [])
          .map((id) => definitionNamesById.get(id) ?? id)
          .join(" ");
        return `${ref.name} ${ref.description} ${covered}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const aIn = a.matchups.includes(matchup) ? 0 : 1;
        const bIn = b.matchups.includes(matchup) ? 0 : 1;
        return aIn - bIn || a.name.localeCompare(b.name);
      });
  }, [references, matchup, query, definitionNamesById, showOtherMatchups]);
  const matchupCount = references.filter((r) =>
    r.matchups.includes(matchup),
  ).length;
  const hiddenCount = references.length - matchupCount;

  const handleAdaptAll = async () => {
    if (bulkState.running || customBuilds.length === 0) return;
    setBulkState({ running: true, done: 0, total: customBuilds.length });
    let saved = 0;
    const failures: string[] = [];
    for (const build of customBuilds) {
      try {
        const result = adaptSource(toSource(build));
        const validVs = ["Protoss", "Terran", "Zerg", "Random", "Any"];
        const buildVs = validVs.includes(build.vsRace ?? "")
          ? (build.vsRace as VsRace)
          : vsRace;
        const payload = toCustomBuildPayload(result, {
          name: `${build.name} (${profileId})`,
          vsRace: buildVs,
          description: `Re-timed from "${build.name}" for patch ${profileId}.`,
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
        description: `Each as "name (${profileId})" in your library.`,
      });
    }
    if (failures.length > 0) {
      toast.error(`Couldn't adapt ${failures.length}`, {
        description: failures.slice(0, 4).join(", "),
      });
    }
  };

  return (
    <Card title="Reference build (12-worker)">
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-caption font-medium text-text">
              Standard openers
            </div>
            <span className="text-caption text-text-dim">
              {matchupCount} {matchup} builds · covers the full definitions
              catalog
            </span>
          </div>
          <Input
            inputSize="sm"
            type="search"
            placeholder="Search builds and the definitions they cover…"
            aria-label="Search standard openers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul
            className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1"
            role="radiogroup"
            aria-label="Standard openers"
          >
            {sortedReferences.map((ref) => {
              const key = `standard:${ref.id}`;
              const isSelected = selected === key;
              const playedInMatchup = ref.matchups.includes(matchup);
              return (
                <li key={key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelected(key)}
                    className={[
                      "w-full rounded-lg border-2 p-3 text-left transition-colors",
                      isSelected
                        ? "border-line bg-accent/10 shadow-hard"
                        : "border-line/25 bg-bg-surface hover:border-line/60",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-body font-semibold text-text">
                        {ref.name}
                      </span>
                      {playedInMatchup ? (
                        <Badge variant="cyan" size="sm">
                          {matchup}
                        </Badge>
                      ) : (
                        <Badge variant="neutral" size="sm">
                          {ref.matchups.join(" · ")}
                        </Badge>
                      )}
                      {ref.native ? (
                        <Badge variant="accent" size="sm">
                          {ref.native}-native
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-caption text-text-muted">
                      {ref.description}
                    </p>
                    {(ref.definitionIds?.length ?? 0) > 0 ? (
                      <p className="mt-0.5 text-caption text-text-dim">
                        covers:{" "}
                        {(ref.definitionIds ?? [])
                          .map((id) => definitionNamesById.get(id) ?? id)
                          .slice(0, 3)
                          .join(" · ")}
                        {(ref.definitionIds?.length ?? 0) > 3
                          ? ` · +${(ref.definitionIds?.length ?? 0) - 3} more`
                          : ""}
                      </p>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {!query.trim() && hiddenCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowOtherMatchups((v) => !v)}
            >
              {showOtherMatchups
                ? `Hide other matchups`
                : `Show ${hiddenCount} openers from other matchups`}
            </Button>
          ) : null}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-caption font-medium text-text">My builds</div>
            <SignedIn>
              {customBuilds.length > 0 ? (
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
            </SignedIn>
          </div>
          <SignedIn>
            {customBuilds.length === 0 ? (
              <p className="text-caption text-text-dim">
                No saved {race} builds with step data yet — builds from your{" "}
                <Link href="/builds" className="text-accent hover:underline">
                  library
                </Link>{" "}
                (signature or rules) appear here.
              </p>
            ) : (
              <ul className="space-y-1.5" role="radiogroup" aria-label="My builds">
                {customBuilds.map((build) => {
                  const key = `custom:${build.slug}`;
                  const isSelected = selected === key;
                  const stepCount =
                    build.signature?.length ?? build.rules?.length ?? 0;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setSelected(key)}
                        className={[
                          "w-full rounded-lg border-2 p-3 text-left transition-colors",
                          isSelected
                            ? "border-line bg-accent/10 shadow-hard"
                            : "border-line/25 bg-bg-surface hover:border-line/60",
                        ].join(" ")}
                      >
                        <span className="text-body font-semibold text-text">
                          {build.name}
                        </span>
                        <span className="ml-2 text-caption text-text-dim">
                          {stepCount} steps
                          {build.signature?.length ? "" : " (from rules)"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </SignedIn>
          <SignedOut>
            <p className="text-caption text-text-dim">
              Sign in to adapt builds from your own library.
            </p>
          </SignedOut>
        </div>
        <div className="space-y-2">
          <Button
            disabled={!selectedSource}
            onClick={() => selectedSource && onAdapt(selectedSource)}
            iconLeft={<ArrowRightLeft className="h-4 w-4" />}
          >
            Re-time for selected patch
          </Button>
          <p className="text-caption text-text-dim">
            Worker production and gas saturation are re-derived for the
            target patch — the build&apos;s structures, units, upgrades, and
            supply keep their order.
          </p>
          {error ? (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
