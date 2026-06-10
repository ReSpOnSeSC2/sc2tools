"use client";

/**
 * Reference build picker: shipped standard 12-worker openers for the
 * selected race, plus the user's own saved custom builds (which carry
 * step signatures). The selected build is what gets re-timed for the
 * target patch.
 */
import { useMemo, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import type { BuildSignatureItem } from "@/lib/build-events";
import { matchupLabel } from "@/lib/race";
import type { ReferenceBuild, SimRace } from "@/lib/optimizer/types";

export type BuildSource =
  | {
      type: "standard";
      id: string;
      name: string;
      steps: string[];
    }
  | {
      type: "custom";
      id: string;
      name: string;
      signature: BuildSignatureItem[];
    };

interface CustomBuildListItem {
  slug: string;
  name: string;
  race?: string;
  vsRace?: string;
  signature?: BuildSignatureItem[];
}

export function BuildSourcePanel({
  race,
  vsRace,
  references,
  error,
  onAdapt,
}: {
  race: SimRace;
  vsRace: SimRace;
  references: ReferenceBuild[];
  error: string | null;
  onAdapt: (source: BuildSource) => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const { data: customData } = useApi<{ items: CustomBuildListItem[] }>(
    "/v1/custom-builds",
  );
  const matchup = matchupLabel(race, vsRace);

  const customBuilds = useMemo(
    () =>
      (customData?.items ?? []).filter(
        (item) =>
          item.race === race &&
          Array.isArray(item.signature) &&
          item.signature.length > 0,
      ),
    [customData, race],
  );

  const sources = useMemo<Map<string, BuildSource>>(() => {
    const map = new Map<string, BuildSource>();
    for (const ref of references) {
      map.set(`standard:${ref.id}`, {
        type: "standard",
        id: ref.id,
        name: ref.name,
        steps: ref.steps,
      });
    }
    for (const build of customBuilds) {
      map.set(`custom:${build.slug}`, {
        type: "custom",
        id: build.slug,
        name: build.name,
        signature: build.signature ?? [],
      });
    }
    return map;
  }, [references, customBuilds]);

  const selectedSource = sources.get(selected) ?? null;

  return (
    <Card title="Reference build (12-worker)">
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="text-caption font-medium text-text">
            Standard openers
          </div>
          <ul className="space-y-1.5" role="radiogroup" aria-label="Standard openers">
            {references.map((ref) => {
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
                    </div>
                    <p className="mt-0.5 text-caption text-text-muted">
                      {ref.description}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="space-y-2">
          <div className="text-caption font-medium text-text">My builds</div>
          <SignedIn>
            {customBuilds.length === 0 ? (
              <p className="text-caption text-text-dim">
                No saved {race} builds with step data yet — builds you save in
                your library (with a build-order signature) appear here.
              </p>
            ) : (
              <ul className="space-y-1.5" role="radiogroup" aria-label="My builds">
                {customBuilds.map((build) => {
                  const key = `custom:${build.slug}`;
                  const isSelected = selected === key;
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
                          {build.signature?.length ?? 0} steps
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
            Worker production, supply, and gas saturation are re-derived for
            the target patch — the build&apos;s structures, units, and
            upgrades keep their order.
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
