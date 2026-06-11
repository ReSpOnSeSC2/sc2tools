"use client";

/**
 * Build adapter page orchestrator.
 *
 * Pick any of your parsed games, upload a fresh .SC2Replay, or choose
 * a saved build — then Adapt: the deterministic economy simulation
 * re-times the build for the other economy (12-worker ↔ 8-worker),
 * keeping the same structures, units, and upgrades in the same order
 * while every timing and supply stamp is recomputed for the target
 * patch.
 *
 * Direction is auto-detected (ladder games are 12-worker starts) and
 * swappable, and changing direction or the opening window re-adapts
 * the current build in place. Everything runs locally — the only
 * server calls load your games/builds and the optional export back
 * into the library.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Tabs } from "@/components/ui/Tabs";
import { ToastProvider } from "@/components/ui/Toast";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { coerceVsRace } from "@/lib/race";
import {
  actionsFromCustomBuild,
  adaptBuild,
} from "@/lib/optimizer/adapt/adapt";
import { actionsFromReplayEvents } from "@/lib/optimizer/adapt/fromReplay";
import {
  DEFAULT_PROFILE_ID,
  listProfiles,
  resolveProfile,
} from "@/lib/optimizer/patch/profiles";
import { defaultPolicies } from "@/lib/optimizer/sim/engine";
import type { AdaptResult } from "@/lib/optimizer/types";
import { AdaptDirectionPanel } from "./AdaptDirectionPanel";
import { BuildOrderTimeline } from "./BuildOrderTimeline";
import { ComparisonView } from "./ComparisonView";
import { EconomyCharts } from "./EconomyCharts";
import { ExportToBuildsButton } from "./ExportToBuildsButton";
import { MyGamesPanel } from "./MyGamesPanel";
import { SavedBuildsPanel } from "./SavedBuildsPanel";
import { UploadReplayPanel } from "./UploadReplayPanel";
import type { BuildSource } from "./buildSource";

/** Patch real ladder replays + legacy reference builds live on. */
const BASELINE_PROFILE_ID = "lotv-base";

export interface AdapterSettings {
  /** Patch the source build/replay was played on. */
  fromProfileId: string;
  /** Patch to re-time it for. */
  toProfileId: string;
  /** Replay opening window in seconds; 0 = whole game. */
  cutoffSec: number;
}

const DEFAULT_SETTINGS: AdapterSettings = {
  fromProfileId: BASELINE_PROFILE_ID,
  toProfileId: DEFAULT_PROFILE_ID,
  cutoffSec: 420,
};

function isSettings(raw: unknown): raw is AdapterSettings {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Partial<AdapterSettings>;
  return (
    typeof s.fromProfileId === "string" &&
    typeof s.toProfileId === "string" &&
    typeof s.cutoffSec === "number" &&
    s.fromProfileId !== s.toProfileId
  );
}

type SourceTab = "games" | "upload" | "saved";

export function OptimizerClient() {
  return (
    <ToastProvider>
      <OptimizerInner />
    </ToastProvider>
  );
}

function OptimizerInner() {
  const [settings, setSettings] = useLocalStorageState<AdapterSettings>(
    "optimizer.settings.v3",
    DEFAULT_SETTINGS,
    isSettings,
  );
  const [tab, setTab] = useState<SourceTab>("games");
  const [result, setResult] = useState<AdaptResult | null>(null);
  const [adaptError, setAdaptError] = useState<string | null>(null);
  // The last adapted source, so direction/cutoff changes re-adapt it
  // in place instead of leaving a stale result on screen.
  const lastSourceRef = useRef<BuildSource | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const profiles = useMemo(() => listProfiles(), []);

  const adaptSource = (source: BuildSource): AdaptResult => {
    const targetProfile = resolveProfile(settings.toProfileId);
    const resolved =
      source.type === "replay"
        ? actionsFromReplayEvents(
            targetProfile,
            source.events,
            settings.cutoffSec > 0 ? settings.cutoffSec : undefined,
          )
        : actionsFromCustomBuild(targetProfile, source);
    if (resolved.actions.length === 0) {
      throw new Error(
        source.type === "replay"
          ? "No adaptable steps inside the selected opening window (workers and supply are re-timed automatically — try a wider window)."
          : "That build has no adaptable steps (workers and supply are re-timed automatically — it needs structures, units, or upgrades).",
      );
    }
    // Builds whose milestones run past the default window (a 10:00
    // opening cut, or a saved "3 stargates by 10:00" build) get a
    // longer simulation.
    const horizonSec = Math.min(
      900,
      Math.max(480, (resolved.latestMilestoneSec ?? 0) + 90),
    );
    const adapted = adaptBuild({
      baselineProfileId: settings.fromProfileId,
      profileId: settings.toProfileId,
      race: source.race,
      actions: resolved.actions,
      referenceName: source.name,
      referenceId: source.id,
      threats: [],
      policies: defaultPolicies(),
      safety: { hasWall: true, allowWorkerPull: true },
      horizonSec,
    });
    const adaptationNotes = resolved.fromRules
      ? [
          "Reconstructed from this build's detection rules — the milestones plus their implied tech and gas. Steps the rules don't mention (expansions, extra army) aren't included; save the build with a full signature for higher fidelity.",
          ...adapted.adaptationNotes,
        ]
      : adapted.adaptationNotes;
    return { ...adapted, unknownNames: resolved.unknownNames, adaptationNotes };
  };

  const handleAdapt = (source: BuildSource) => {
    setAdaptError(null);
    try {
      setResult(adaptSource(source));
      lastSourceRef.current = source;
      // On phones the results render below the source list — bring
      // them into view so "Adapt" visibly does something.
      resultsRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (err: unknown) {
      setAdaptError(err instanceof Error ? err.message : String(err));
    }
  };

  // Direction or opening-window changes re-time the current build so
  // the on-screen result always matches the controls.
  useEffect(() => {
    const source = lastSourceRef.current;
    if (!source) return;
    try {
      setResult(adaptSource(source));
      setAdaptError(null);
    } catch (err: unknown) {
      setAdaptError(err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fromProfileId, settings.toProfileId, settings.cutoffSec]);

  const updateSettings = (patch: Partial<AdapterSettings>) => {
    setSettings({ ...settings, ...patch });
  };

  const exportVsRace = coerceVsRace(lastSourceRef.current?.vsRace);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Patch-aware planning"
        title="Build adapter"
        description={
          <>
            Take any of your games — or an uploaded replay — and re-time
            its build for the other economy, 12-worker ↔ 8-worker. Same
            structures, same order, new timings, computed by a
            deterministic economy simulation.
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,2fr)_minmax(420px,3fr)]">
        <div className="space-y-6">
          <Card title="Build source">
            <div className="p-4">
              <Tabs
                value={tab}
                onValueChange={(next) => setTab(next as SourceTab)}
              >
                <Tabs.List ariaLabel="Build source">
                  <Tabs.Trigger value="games">My games</Tabs.Trigger>
                  <Tabs.Trigger value="upload">Upload replay</Tabs.Trigger>
                  <Tabs.Trigger value="saved">Saved builds</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="games">
                  <MyGamesPanel onAdapt={handleAdapt} />
                </Tabs.Content>
                <Tabs.Content value="upload">
                  <UploadReplayPanel onAdapt={handleAdapt} />
                </Tabs.Content>
                <Tabs.Content value="saved">
                  <SavedBuildsPanel
                    toProfileId={settings.toProfileId}
                    onAdapt={handleAdapt}
                    adaptSource={adaptSource}
                  />
                </Tabs.Content>
              </Tabs>
              {adaptError ? (
                <p role="alert" className="mt-3 text-caption text-danger">
                  {adaptError}
                </p>
              ) : null}
            </div>
          </Card>
          <AdaptDirectionPanel
            settings={settings}
            profiles={profiles}
            onChange={updateSettings}
          />
        </div>
        <div ref={resultsRef} className="scroll-mt-4 space-y-6">
          <BuildOrderTimeline result={result} />
          <ComparisonView result={result} />
          <EconomyCharts result={result} />
          <ExportToBuildsButton result={result} vsRace={exportVsRace} />
        </div>
      </div>
    </div>
  );
}
