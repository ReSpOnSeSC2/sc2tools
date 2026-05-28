"use client";

/**
 * Settings · Build randomizer.
 *
 * Streamers curate, per matchup, a pool of build orders drawn from the
 * bundled BUILD_DEFINITIONS catalog AND their own custom builds. Pools
 * can be equal-chance (default) or weighted with sliders. The widget
 * picks one at random for each new game and reveals it on stream via a
 * randomly-chosen animation (case unboxing, slot machine, gacha
 * summon, battle royale, or wheel spin).
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Volume2, VolumeX } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { SaveBar } from "@/components/ui/SaveBar";
import { useToast } from "@/components/ui/Toast";
import { useDirtyForm } from "@/components/ui/useDirtyForm";
import type { CustomBuild } from "@/components/builds/types";
import {
  activeMatchupCount,
  defaultRandomizerConfig,
  sanitizeRandomizerConfig,
  withMatchup,
} from "@/lib/randomizer/config";
import {
  MATCHUPS,
  type MatchupKey,
  type RandomizerConfig,
  type RandomizerSound,
} from "@/lib/randomizer/types";
import {
  setRevealSoundEnabled,
  setRevealSoundVolume,
} from "@/components/randomizer/reveals/revealSound";
import { MatchupSelector } from "./randomizer/MatchupSelector";
import { MatchupBuildPicker } from "./randomizer/MatchupBuildPicker";
import { RandomizerPreview } from "./randomizer/RandomizerPreview";
import { usePublishDirty } from "./SettingsContext";

type CustomBuildsResp = { items: CustomBuild[] };

export function SettingsRandomizer() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<unknown>(
    "/v1/me/preferences/randomizer",
  );
  const customBuildsApi = useApi<CustomBuildsResp>("/v1/custom-builds");
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState<MatchupKey>(MATCHUPS[0]);

  const serverConfig = useMemo<RandomizerConfig | undefined>(
    () => (data === undefined ? undefined : sanitizeRandomizerConfig(data)),
    [data],
  );

  const { draft, setDraft, dirty, reset, markSaved } =
    useDirtyForm<RandomizerConfig>(serverConfig, defaultRandomizerConfig());

  usePublishDirty("randomizer", dirty);

  // Keep the audio engine in sync with the draft so the live preview
  // reflects the sound toggle / volume immediately.
  useEffect(() => {
    setRevealSoundEnabled(draft.sound.enabled);
    setRevealSoundVolume(draft.sound.volume);
  }, [draft.sound.enabled, draft.sound.volume]);

  async function save() {
    if (saving) return;
    setSaving(true);
    const previous = data;
    try {
      await mutate(draft as unknown, { revalidate: false });
      await apiCall(getToken, "/v1/me/preferences/randomizer", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await mutate();
      markSaved();
      toast.success("Randomizer saved");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't save randomizer", { description: message });
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || customBuildsApi.isLoading) {
    return <Skeleton rows={3} />;
  }

  const customBuilds = customBuildsApi.data?.items ?? [];
  const activeCount = activeMatchupCount(draft);
  const matchupConfig = draft.matchups[active];

  return (
    <>
      <Section
        title="Build randomizer"
        description={
          activeCount === 0
            ? "Pick a matchup, enable the randomizer, and select which builds it can roll. The widget spins a build for you (and your stream) when each new game loads."
            : `Active on ${activeCount} matchup${activeCount === 1 ? "" : "s"}. The OBS widget spins automatically when the agent reports a new game.`
        }
      >
        <Card>
          <MatchupSelector
            config={draft}
            active={active}
            onSelect={setActive}
          />
        </Card>
      </Section>

      <MatchupBuildPicker
        matchup={active}
        config={matchupConfig}
        customBuilds={customBuilds}
        onChange={(next) => setDraft((d) => withMatchup(d, active, next))}
      />

      <SoundSettings
        sound={draft.sound}
        onChange={(sound) => setDraft((d) => ({ ...d, sound }))}
      />

      <RandomizerPreview matchup={active} config={matchupConfig} />

      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={save}
        onReset={reset}
      />
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
