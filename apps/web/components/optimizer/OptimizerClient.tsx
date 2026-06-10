"use client";

/**
 * Build-order optimizer page orchestrator.
 *
 * Left column: matchup/objective setup, threat selection driven by
 * scouting observations, run controls. Right column: the optimized
 * build order, per-threat safety report, and economy charts.
 *
 * The engine runs client-side in a Web Worker (lib/optimizer); no
 * server round-trips except the optional export to custom builds.
 */
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ToastProvider } from "@/components/ui/Toast";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import {
  DEFAULT_PROFILE_ID,
  listProfiles,
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
  ObjectiveSpec,
  OptimizeRequest,
  ScoutingObservation,
  SimRace,
} from "@/lib/optimizer/types";
import { useOptimizerWorker } from "@/lib/optimizer/worker/useOptimizerWorker";
import { BuildOrderTimeline } from "./BuildOrderTimeline";
import { EconomyCharts } from "./EconomyCharts";
import { ExportToBuildsButton } from "./ExportToBuildsButton";
import { RunControls } from "./RunControls";
import { SafetyReportView } from "./SafetyReportView";
import { SetupPanel } from "./SetupPanel";
import { ThreatPanel } from "./ThreatPanel";

const DEFAULT_BUDGET = { maxGenerations: 150, maxMillis: 8000 };

export interface OptimizerSettings {
  race: SimRace;
  vsRace: SimRace;
  objectiveId: ObjectiveSpec["id"];
  objectiveAtSec: number;
  profileId: string;
  hasWall: boolean;
  allowWorkerPull: boolean;
}

const DEFAULT_SETTINGS: OptimizerSettings = {
  race: "Protoss",
  vsRace: "Zerg",
  objectiveId: "earliest-safe-expansion",
  objectiveAtSec: 360,
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
    typeof s.objectiveId === "string" &&
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
    "optimizer.settings.v1",
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
  const worker = useOptimizerWorker();

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

  const buildRequest = (): OptimizeRequest => {
    const latestWave = activeThreats.reduce(
      (max, { threat }) =>
        Math.max(max, ...threat.waves.map((w) => w.timeSec)),
      0,
    );
    const horizonSec = Math.max(
      360,
      latestWave + 60,
      settings.objectiveAtSec + 30,
    );
    return {
      profileId: settings.profileId,
      race: settings.race,
      vsRace: settings.vsRace,
      objective: { id: settings.objectiveId, atSec: settings.objectiveAtSec },
      threats: activeThreats,
      policies: defaultPolicies(),
      safety: {
        hasWall: settings.hasWall,
        allowWorkerPull: settings.allowWorkerPull,
      },
      seed: Math.floor(Math.random() * 2 ** 31),
      budget: DEFAULT_BUDGET,
      horizonSec,
    };
  };

  const updateSettings = (patch: Partial<OptimizerSettings>) => {
    setSettings({ ...settings, ...patch });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Patch-aware planning"
        title="Build order optimizer"
        description={
          <>
            Search for the safest opening on the current balance patch given
            what you scout. Safety margins are planning estimates from a
            deterministic economy simulation — no positioning or micro.
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
          <RunControls
            status={worker.status}
            progress={worker.progress}
            error={worker.error}
            maxGenerations={DEFAULT_BUDGET.maxGenerations}
            threatCount={activeThreats.length}
            likelyCount={
              assessments.filter(
                (a) => a.active || pinnedThreatIds.includes(a.threatId),
              ).length
            }
            onRun={() => worker.run(buildRequest())}
            onCancel={worker.cancel}
          />
        </div>
        <div className="space-y-6">
          <BuildOrderTimeline result={worker.result} status={worker.status} />
          <SafetyReportView result={worker.result} />
          <EconomyCharts result={worker.result} />
          <ExportToBuildsButton result={worker.result} vsRace={settings.vsRace} />
        </div>
      </div>
    </div>
  );
}
