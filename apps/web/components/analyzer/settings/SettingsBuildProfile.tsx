"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { BuildProfileEditor } from "@/components/dock/BuildProfileEditor";
import { sanitizeStudioState, type StudioState } from "@/lib/multichat/useStudioState";
import { newestStudioSnapshot, useStudioUpdates } from "@/lib/multichat/useStudioUpdates";

/** Authenticated Settings surface for the same token-backed OBS Dock controls. */
export function SettingsBuildProfile({ token }: { token: string }) {
  const { data, error, mutate, request } = useApi<unknown>(
    `/v1/multichat/${encodeURIComponent(token)}/studio`,
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const postingRef = useRef(false);
  const currentTokenRef = useRef(token);
  currentTokenRef.current = token;
  const latestStudioRef = useRef<{ token: string; state: StudioState } | null>(null);
  const pendingStudioRef = useRef<{ token: string; state: StudioState } | null>(null);
  const wireReady = Boolean(data && typeof data === "object" && !Array.isArray(data));
  const wireStudio = useMemo(() => sanitizeStudioState(data), [data]);
  const previous = latestStudioRef.current?.token === token ? latestStudioRef.current.state : null;
  // Cache renders are not new arrivals. On an equal timestamp, retain the
  // state already adopted from a live event rather than replaying old cache.
  if (wireReady) latestStudioRef.current = { token, state: previous ? newestStudioSnapshot(wireStudio, previous) : wireStudio };
  const studio = latestStudioRef.current?.token === token ? latestStudioRef.current.state : wireStudio;
  const ready = wireReady || latestStudioRef.current?.token === token;

  useEffect(() => {
    // Old token requests may still finish, but cannot hold or change this
    // token's controls, buffer, or cache after a route/account transition.
    postingRef.current = false;
    pendingStudioRef.current = null;
    setBusy(false);
    setSaveError(null);
  }, [token]);

  const adoptSnapshot = (next: StudioState): StudioState | null => {
    if (currentTokenRef.current !== token) return null;
    const latest = latestStudioRef.current?.token === token ? latestStudioRef.current.state : null;
    const selected = newestStudioSnapshot(latest, next);
    latestStudioRef.current = { token, state: selected };
    return selected;
  };

  useStudioUpdates(token, (next) => {
    const selected = adoptSnapshot(next);
    if (!selected) return;
    if (postingRef.current) {
      // Calling SWR mutate here would cancel the result of our own pending
      // async POST mutation. Hold its echo and any newer external update.
      pendingStudioRef.current = { token, state: selected };
    } else {
      // A live mutation also invalidates any GET that started before it.
      void mutate(selected, { revalidate: false });
    }
  }, true, true);

  const postStudio = async (patch: Record<string, unknown>): Promise<StudioState | null> => {
    if (postingRef.current) return null;
    postingRef.current = true;
    setBusy(true);
    setSaveError(null);
    let saved: StudioState | null = null;
    try {
      // SWR marks the resource as mutating before the POST starts. A GET
      // already in flight must not undo the returned Show/Hide snapshot.
      const result = await mutate(async () => {
        const raw = await request<unknown>({ method: "POST", body: JSON.stringify(patch) });
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid studio response");
        const posted = sanitizeStudioState(raw);
        const pending = pendingStudioRef.current?.token === token ? pendingStudioRef.current.state : null;
        // Socket arrival ordering disambiguates same-millisecond writes:
        // the buffered live update wins a tie with this HTTP response.
        const selected = adoptSnapshot(pending ? newestStudioSnapshot(posted, pending) : posted);
        if (!selected) throw new Error("Overlay token changed");
        // latestStudioRef already includes buffered socket arrivals. Pick
        // that version before the POST mutation commits its cache value.
        return selected;
      }, { revalidate: false });
      if (result && currentTokenRef.current === token) saved = adoptSnapshot(sanitizeStudioState(result));
    } catch {
      if (currentTokenRef.current === token) setSaveError("Save failed — check the connection and try again.");
    } finally {
      if (currentTokenRef.current === token) {
        // The outer SWR mutation has now settled. Flush arrivals from the
        // interval between its callback returning and its cache commit;
        // external saved updates also survive a failed local POST.
        postingRef.current = false;
        const pending = pendingStudioRef.current?.token === token ? pendingStudioRef.current.state : null;
        pendingStudioRef.current = null;
        if (pending) {
          const selected = adoptSnapshot(pending);
          if (selected) await mutate(selected, { revalidate: false });
        }
        setBusy(false);
      }
    }
    return saved && latestStudioRef.current?.token === token ? latestStudioRef.current.state : null;
  };

  return (
    <Section id="build-profile" className="scroll-mt-28"
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
