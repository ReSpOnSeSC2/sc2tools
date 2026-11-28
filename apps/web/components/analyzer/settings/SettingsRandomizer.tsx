"use client";

/**
 * Settings · Build randomizer.
 *
 * Race, then matchup, then what each game draws: a build order, opening
 * units, or both, each behind its own switch. Streamers curate, per
 * matchup, a pool of build orders drawn from the bundled
 * BUILD_DEFINITIONS catalog and their own custom builds, equal-chance or
 * weighted, and the units a draw picks from. The widget reveals each
 * game's draw on stream with a randomly chosen animation.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Volume2, VolumeX } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import { useCustomBuildPage } from "@/components/builds/useCustomBuildPage";
import {
  defaultRandomizerConfig,
  sanitizeRandomizerConfig,
  withMatchup,
} from "@/lib/randomizer/config";
import {
  MATCHUPS,
  type MatchupConfig,
  type MatchupKey,
  type RandomizerConfig,
  type RandomizerSound,
} from "@/lib/randomizer/types";
import {
  setRevealSoundEnabled,
  setRevealSoundVolume,
} from "@/components/randomizer/reveals/revealSound";
import { MatchupBuildPicker } from "./randomizer/MatchupBuildPicker";
import { MatchupSection } from "./randomizer/MatchupSection";
import { RandomizerPreview } from "./randomizer/RandomizerPreview";
import { RandomizerSkeleton } from "./randomizer/RandomizerSkeleton";
import { UnitDrawSettings } from "./randomizer/UnitDrawSettings";
import { useSaveSource } from "./SettingsContext";
import { SettingsLoadError } from "./SettingsLoadError";
import { RandomizerChallenge } from "@/components/practice/RandomizerChallenge";
import { SettingsSectionsReady } from "./SettingsSectionNav";

export function SettingsRandomizer() {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<unknown>(
    "/v1/me/preferences/randomizer",
  );
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<MatchupKey>(MATCHUPS[0]);
  const [buildSearch, setBuildSearch] = useState("");
  const customBuildsApi = useCustomBuildPage({
    matchup: active,
    includeGeneric: true,
    search: buildSearch,
    sort: "name",
    view: "summary",
  });

  const serverConfig = useMemo<RandomizerConfig | undefined>(
    () => (data === undefined ? undefined : sanitizeRandomizerConfig(data)),
    [data],
  );

  const serverPool = useMemo(() => {
    if (!serverConfig) return undefined;
    const config = { ...serverConfig };
    delete config.rollOnDesktop;
    return config;
  }, [serverConfig]);
  const { draft, setDraft, dirty, reset, markSaved } =
    useDirtyForm<RandomizerConfig>(serverPool, defaultRandomizerConfig());
  const desktop = useDirtyForm(serverConfig?.rollOnDesktop, false);

  useSaveSource("randomizer", {
    label: "randomizer", dirty: dirty || desktop.dirty, save,
    reset: () => { reset(); desktop.reset(); },
  }, "build-randomizer");

  // Keep the audio engine in sync with the draft so the live preview
  // reflects the sound toggle / volume immediately.
  useEffect(() => {
    setRevealSoundEnabled(draft.sound.enabled);
    setRevealSoundVolume(draft.sound.volume);
  }, [draft.sound.enabled, draft.sound.volume]);

  async function save(): Promise<boolean> {
    if (!dirty && !desktop.dirty) return true;
    if (saving) return false;
    setSaving(true);
    const previous = data;
    try {
      await mutate({ ...draft, rollOnDesktop: desktop.draft }, { revalidate: false });
      await apiCall(getToken, "/v1/me/preferences/randomizer", {
        method: "PUT",
        body: JSON.stringify({ ...draft, ...(desktop.dirty ? { rollOnDesktop: desktop.draft } : {}) }),
      });
      await mutate();
      markSaved();
      desktop.markSaved();
      toast.success("Randomizer saved");
      return true;
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't save randomizer", { description: message });
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return <><SettingsSectionsReady revision="loading" /><RandomizerSkeleton /></>;
  }
  if (error && data === undefined) return <><SettingsSectionsReady revision="error" /><SettingsLoadError tab="Randomizer settings" error={error} retry={mutate} /></>;

  const customBuilds = customBuildsApi.data?.items ?? [];
  const matchupConfig = draft.matchups[active];
  const changeMatchup = (next: MatchupConfig) => setDraft((d) => withMatchup(d, active, next));
  // Units drawn alone: their settings come first, above the build pool kept for later.
  const unitsFirst = !matchupConfig.enabled && matchupConfig.unitRandomizerEnabled;
  const unitDraw = <UnitDrawSettings matchup={active} config={matchupConfig} onChange={changeMatchup} />;

  return (
    <>
      <SettingsSectionsReady revision="ready" />
      <MatchupSection
        draft={draft}
        active={active}
        onSelect={setActive}
        onChange={changeMatchup}
        desktop={{ checked: desktop.draft, disabled: !desktop.hydrated || saving, onChange: desktop.setDraft }}
      />

      {unitsFirst ? unitDraw : null}
      <MatchupBuildPicker
        matchup={active}
        config={matchupConfig}
        customBuilds={customBuilds}
        search={buildSearch}
        onSearchChange={setBuildSearch}
        customBuildPage={customBuildsApi}
        onChange={changeMatchup}
      />
      {unitsFirst ? null : unitDraw}

      <SoundSettings
        sound={draft.sound}
        onChange={(sound) => setDraft((d) => ({ ...d, sound }))}
      />

      <RandomizerPreview matchup={active} config={matchupConfig} />
      <RandomizerChallenge />
    </>
  );
}

function SoundSettings({
  sound,
  onChange,
}: {
  sound: RandomizerSound;
  onChange: (next: RandomizerSound) => void;
}) {
  const pct = Math.round(sound.volume * 100);
  return (
    <Section
      id="sound-effects" className="scroll-mt-28"
      title="Sound effects"
      description="Procedural sound cues that play during the reveal (wheel ticks, lasers, gallop, bumps) plus a winner fanfare. Plays in OBS and in the preview below."
    >
      <Card>
        <div className="space-y-4">
          <label className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-bg-elevated px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-body font-medium text-text">
                {sound.enabled ? (
                  <Volume2 className="h-4 w-4 text-accent-cyan" aria-hidden />
                ) : (
                  <VolumeX className="h-4 w-4 text-text-muted" aria-hidden />
                )}
                Play sound effects
              </span>
              <span className="mt-0.5 block text-caption text-text-muted">
                In OBS, audio is captured from the Browser Source — control it
                from your mixer too.
              </span>
            </span>
            <Toggle
              checked={sound.enabled}
              onChange={(on) => onChange({ ...sound, enabled: on })}
              label="Play sound effects"
            />
          </label>
          <div
            className={[
              "flex items-center gap-3 px-1",
              sound.enabled ? "" : "opacity-50",
            ].join(" ")}
          >
            <label htmlFor="rdz-volume" className="text-caption font-medium text-text">
              Volume
            </label>
            <input
              id="rdz-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              disabled={!sound.enabled}
              onChange={(e) =>
                onChange({ ...sound, volume: Number(e.target.value) / 100 })
              }
              className="h-1 flex-1 cursor-pointer accent-accent-cyan"
            />
            <span className="w-10 text-right text-caption tabular-nums text-text">
              {pct}%
            </span>
          </div>
        </div>
      </Card>
    </Section>
  );
}
