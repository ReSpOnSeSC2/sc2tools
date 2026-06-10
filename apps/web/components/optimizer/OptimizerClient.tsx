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
import {
  actionsFromCustomBuild,
  actionsFromSteps,
  adaptBuild,
  referenceBuildsForRace,
} from "@/lib/optimizer/adapt/adapt";
import {
  DEFAULT_PROFILE_ID,
  listProfiles,
  resolveProfile,
} from "@/lib/optimizer/patch/profiles";
import { deriveThreatsForMatchup } from "@/lib/optimizer/threats/derive";
import { defaultPolicies } from "@/lib/optimizer/sim/engine";
import {
  THREAT_OVERLAY_STORAGE_KEY,
  emptyOverlay,
  isThreatOverlay,
  threatCatalog,
  threatsForMatchup,
  type ThreatOverlay,
} from "@/lib/optimizer/threats/store";
import type { AdaptResult, SimRace, Threat } from "@/lib/optimizer/types";
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
  const [disabledThreatIds, setDisabledThreatIds] = useState<string[]>([]);
  const [result, setResult] = useState<AdaptResult | null>(null);
  const [adaptError, setAdaptError] = useState<string | null>(null);

  const profiles = useMemo(() => listProfiles(), []);
  const catalog = useMemo(() => threatCatalog(overlay), [overlay]);
  const matchupThreats = useMemo(() => {
    // Derived threats: every catalog opener the opponent can play,
    // simulated on the selected patch. Curated extras (8-pool etc.)
    // cover cheeses that aren't catalog openers.
    const curated = threatsForMatchup(catalog, settings.race, settings.vsRace);
    let derived: Threat[] = [];
    try {
      derived = deriveThreatsForMatchup(
        settings.profileId,
        settings.race,
        settings.vsRace,
      );
    } catch {
      // a broken user profile edit shouldn't take down the page
    }
    return [...curated, ...derived].sort(
      (a, b) => a.earliestArrivalSec - b.earliestArrivalSec,
    );
  }, [catalog, settings.race, settings.vsRace, settings.profileId]);
  const activeThreats = useMemo(
    () =>
      matchupThreats
        .filter((t) => !disabledThreatIds.includes(t.id))
        .map((threat) => ({ threat, probability: 1 })),
    [matchupThreats, disabledThreatIds],
  );
  const references = useMemo(
    () => referenceBuildsForRace(settings.race),
    [settings.race],
  );

  const adaptSource = (source: BuildSource): AdaptResult => {
    const profile = resolveProfile(settings.profileId);
    const resolved =
      source.type === "standard"
        ? actionsFromSteps(profile, source.steps)
        : actionsFromCustomBuild(profile, source);
    if (resolved.actions.length === 0) {
      throw new Error(
        "That build has no adaptable steps (workers and supply are re-timed automatically — it needs structures, units, or upgrades).",
      );
    }
    // Patch-native builds (e.g. the 5.0.16 proxy warpgate rush) have
    // no 12-worker ancestor — baseline = their own patch, and the
    // comparison view hides itself.
    const baselineProfileId =
      source.type === "standard" && source.native
        ? source.native
        : BASELINE_PROFILE_ID;
    // Builds whose milestones run past the default window (a saved
    // "3 stargates by 10:00" build) get a longer simulation.
    const horizonSec = Math.min(
      900,
      Math.max(480, (resolved.latestMilestoneSec ?? 0) + 90),
    );
    const adapted = adaptBuild({
      baselineProfileId,
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
            profileId={settings.profileId}
            references={references}
            error={adaptError}
            onAdapt={handleAdapt}
            adaptSource={adaptSource}
          />
          <ThreatPanel
            threats={matchupThreats}
            disabledThreatIds={disabledThreatIds}
            overlay={overlay}
            defenderRace={settings.race}
            onDisabledChange={setDisabledThreatIds}
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
