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
import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
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
} from "@/lib/randomizer/types";
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
