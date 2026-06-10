"use client";

/**
 * Build adapter page orchestrator.
 *
 * Pick a proven 12-worker build order (a shipped standard opener or
 * one of your saved custom builds), and the simulator re-times it for
 * the selected balance patch: same buildings, same order, new supply
 * stamps and timings, with a side-by-side comparison against the
 * original patch and a safety report against the matchup's threats.
 *
 * Everything runs locally — the only server call is loading your
 * custom builds and the optional export back into the library.
 */
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider } from "@/components/ui/Toast";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import type { BuildSignatureItem } from "@/lib/build-events";
import {
  actionsFromSignature,
  actionsFromSteps,
  adaptBuild,
  referenceBuildsForRace,
} from "@/lib/optimizer/adapt/adapt";
import {
  DEFAULT_PROFILE_ID,
  listProfiles,
  resolveProfile,
} from "@/lib/optimizer/patch/profiles";
import {
  activeThreatSet,
  assessThreats,
} from "@/lib/optimizer/scouting/infer";
import { defaultPolicies } from "@/lib/optimizer/sim/engine";
import {
  THREAT_OVERLAY_STORAGE_KEY,
  emptyOverlay,
  isThreatOverlay,
  threatCatalog,
  threatsForMatchup,
  type ThreatOverlay,
} from "@/lib/optimizer/threats/store";
import type {
  AdaptResult,
  ScoutingObservation,
  SimRace,
} from "@/lib/optimizer/types";
import { BuildOrderTimeline } from "./BuildOrderTimeline";
import { BuildSourcePanel, type BuildSource } from "./BuildSourcePanel";
import { ComparisonView } from "./ComparisonView";
import { EconomyCharts } from "./EconomyCharts";
import { ExportToBuildsButton } from "./ExportToBuildsButton";
import { SafetyReportView } from "./SafetyReportView";
import { SetupPanel } from "./SetupPanel";
import { ThreatPanel } from "./ThreatPanel";

/** Patch the shipped/user reference builds were designed on. */
const BASELINE_PROFILE_ID = "lotv-base";

export interface OptimizerSettings {
  race: SimRace;
  vsRace: SimRace;
  profileId: string;
  hasWall: boolean;
  allowWorkerPull: boolean;
}

const DEFAULT_SETTINGS: OptimizerSettings = {
  race: "Protoss",
  vsRace: "Zerg",
  profileId: DEFAULT_PROFILE_ID,
  hasWall: true,
  allowWorkerPull: true,
};

function isSettings(raw: unknown): raw is OptimizerSettings {
  if (!raw || typeof raw !== "object") return false;
  const s = raw as Partial<OptimizerSettings>;
  return (
    typeof s.race === "string" &&
    typeof s.vsRace === "string" &&
    typeof s.profileId === "string"
  );
}

export function OptimizerClient() {
  return (
    <ToastProvider>
      <OptimizerInner />
    </ToastProvider>
  );
}

function OptimizerInner() {
  const [settings, setSettings] = useLocalStorageState<OptimizerSettings>(
    "optimizer.settings.v2",
    DEFAULT_SETTINGS,
    isSettings,
  );
  const [overlay, setOverlay] = useLocalStorageState<ThreatOverlay>(
    THREAT_OVERLAY_STORAGE_KEY,
    emptyOverlay(),
    isThreatOverlay,
  );
  const [observations, setObservations] = useState<ScoutingObservation[]>([]);
  const [pinnedThreatIds, setPinnedThreatIds] = useState<string[]>([]);
  const [result, setResult] = useState<AdaptResult | null>(null);
  const [adaptError, setAdaptError] = useState<string | null>(null);

  const profiles = useMemo(() => listProfiles(), []);
  const catalog = useMemo(() => threatCatalog(overlay), [overlay]);
  const matchupThreats = useMemo(
    () => threatsForMatchup(catalog, settings.race, settings.vsRace),
    [catalog, settings.race, settings.vsRace],
  );
  const assessments = useMemo(
    () => assessThreats(matchupThreats, observations),
    [matchupThreats, observations],
  );
  const activeThreats = useMemo(
    () =>
      activeThreatSet(matchupThreats, assessments, new Set(pinnedThreatIds)),
    [matchupThreats, assessments, pinnedThreatIds],
  );
  const references = useMemo(
    () => referenceBuildsForRace(settings.race),
    [settings.race],
  );

  const handleAdapt = (source: BuildSource) => {
    setAdaptError(null);
    try {
      const profile = resolveProfile(settings.profileId);
      const resolved =
        source.type === "standard"
          ? actionsFromSteps(profile, source.steps)
          : actionsFromSignature(
              profile,
              source.signature as BuildSignatureItem[],
            );
      if (resolved.actions.length === 0) {
        setAdaptError(
          "That build has no adaptable steps (workers and supply are re-timed automatically — it needs structures, units, or upgrades).",
        );
        return;
      }
      const adapted = adaptBuild({
        baselineProfileId: BASELINE_PROFILE_ID,
        profileId: settings.profileId,
        race: settings.race,
        actions: resolved.actions,
        referenceName: source.name,
        referenceId: source.id,
        threats: activeThreats,
        policies: defaultPolicies(),
        safety: {
          hasWall: settings.hasWall,
          allowWorkerPull: settings.allowWorkerPull,
        },
        horizonSec: 480,
      });
      setResult({ ...adapted, unknownNames: resolved.unknownNames });
    } catch (err: unknown) {
      setAdaptError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateSettings = (patch: Partial<OptimizerSettings>) => {
    setSettings({ ...settings, ...patch });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Patch-aware planning"
        title="Build adapter"
        description={
          <>
            Re-time your proven 12-worker build orders for the current balance
            patch: same buildings, same order, new timings — computed by a
            deterministic economy simulation, with a safety check against what
            you scout.
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,2fr)_minmax(420px,3fr)]">
        <div className="space-y-6">
          <SetupPanel
            settings={settings}
            profiles={profiles}
            onChange={updateSettings}
          />
          <BuildSourcePanel
            race={settings.race}
            vsRace={settings.vsRace}
            references={references}
            error={adaptError}
            onAdapt={handleAdapt}
          />
          <ThreatPanel
            threats={matchupThreats}
            assessments={assessments}
            observations={observations}
            pinnedThreatIds={pinnedThreatIds}
            overlay={overlay}
            defenderRace={settings.race}
            onObservationsChange={setObservations}
            onPinnedChange={setPinnedThreatIds}
            onOverlayChange={setOverlay}
          />
        </div>
        <div className="space-y-6">
          <BuildOrderTimeline result={result} />
          <ComparisonView result={result} />
          <SafetyReportView result={result} />
          <EconomyCharts result={result} />
          <ExportToBuildsButton result={result} vsRace={settings.vsRace} />
        </div>
      </div>
    </div>
  );
}
