"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { BuildProfileEditor } from "@/components/dock/BuildProfileEditor";
import { sanitizeStudioState, type StudioState } from "@/lib/multichat/useStudioState";

/** Authenticated Settings surface for the same token-backed OBS Dock controls. */
export function SettingsBuildProfile({ token }: { token: string }) {
  const { data, error, mutate, request } = useApi<unknown>(
    `/v1/multichat/${encodeURIComponent(token)}/studio`,
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ready = Boolean(data && typeof data === "object" && !Array.isArray(data));
  const studio = useMemo(() => sanitizeStudioState(data), [data]);

  const postStudio = async (patch: Record<string, unknown>): Promise<StudioState | null> => {
    setBusy(true);
    setSaveError(null);
    try {
      // SWR marks the resource as mutating before the POST starts. A GET
      // already in flight must not undo the returned Show/Hide snapshot.
      const saved = await mutate(async () => {
        const raw = await request<unknown>({ method: "POST", body: JSON.stringify(patch) });
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid studio response");
        return sanitizeStudioState(raw);
      }, { revalidate: false });
      return saved ? sanitizeStudioState(saved) : null;
    } catch {
      setSaveError("Save failed — check the connection and try again.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Build profile"
      description="Set the five-point graph before a video, then show or hide it here or in your OBS Stream Dock. Both use the same saved ratings."
    >
      <Card>
        <div className="max-w-lg space-y-3">
          {saveError || error ? (
            <div role="alert" className="text-caption text-danger">
              {saveError ?? "Couldn't load saved ratings. Try again."}
              {!ready ? <button type="button" onClick={() => void mutate()} className="ml-2 underline">Retry</button> : null}
            </div>
          ) : null}
          <BuildProfileEditor key={token} profile={studio.buildProfile} busy={busy} ready={ready} onPost={postStudio} />
          <p className="text-caption text-text-muted">
            Enable <strong className="text-text">Build profile</strong> in the widget list above, then copy its URL into its own OBS Browser Source at <strong className="text-text">720 × 900</strong>. Position it clear of gameplay and your camera. Keep the source enabled in OBS; Show widget and Hide widget control the graph.
          </p>
        </div>
      </Card>
    </Section>
  );
}
