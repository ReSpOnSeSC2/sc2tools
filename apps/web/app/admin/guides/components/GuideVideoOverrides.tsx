"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { guideDisplayName } from "@/lib/guides/slugs";
import type {
  GuideAdminNotesPayload,
  GuideAdminNoteSaveBody,
  GuideAdminNoteSaveResponse,
  GuideAdminVideo,
  GuideVideoOverrides,
} from "@/lib/guides/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  AdminNotice,
  EMPTY_OVERRIDES,
  GUIDE_VIDEO_HIDDEN_MAX,
  GUIDE_VIDEO_PINNED_MAX,
  adminErrorText,
  guideNoteApiPath,
  guideNoteKey,
  toggleHidden,
  togglePinned,
  type AdminNoticeValue,
  type AdminResource,
  type GuideSelection,
} from "./guidesAdminShared";

const HEADING_ID = "guide-video-overrides-heading";

export interface GuideVideoOverridesProps {
  videos: ReadonlyArray<GuideAdminVideo>;
  notes: AdminResource<GuideAdminNotesPayload>;
  selection: GuideSelection;
}

/**
 * Videos that can appear on the selected guide: every channel video
 * detected for its matchup plus anything already pinned or hidden there.
 * Order: pinned (in pin order), then auto matches for this build, then
 * the rest in the API's order (newest first).
 */
export function overrideCandidates(
  videos: ReadonlyArray<GuideAdminVideo>,
  selection: GuideSelection,
  overrides: GuideVideoOverrides,
): GuideAdminVideo[] {
  const touched = new Set([...overrides.pinned, ...overrides.hidden]);
  const pool = videos.filter((v) => v.matchup === selection.matchup || touched.has(v.youtubeId));
  const rank = (v: GuideAdminVideo): number => {
    const pin = overrides.pinned.indexOf(v.youtubeId);
    if (pin >= 0) return pin;
    return v.builds.includes(selection.buildKey) ? GUIDE_VIDEO_PINNED_MAX : GUIDE_VIDEO_PINNED_MAX + 1;
  };
  return pool
    .map((video, index) => ({ video, index, rank: rank(video) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.video);
}

/**
 * Saved override ids with no stored channel video (e.g. past the admin
 * list's cap). They can't be shown as rows but still count toward the
 * pin/hide caps, so the card lists them with a way to clear them.
 *
 * Example: `missingOverrideIds([], { pinned: ["YcTMc_Ee11w"], hidden: [] })` → ["YcTMc_Ee11w"].
 */
export function missingOverrideIds(
  videos: ReadonlyArray<GuideAdminVideo>,
  overrides: GuideVideoOverrides,
): string[] {
  const known = new Set(videos.map((video) => video.youtubeId));
  return [...overrides.pinned, ...overrides.hidden].filter((id) => !known.has(id));
}

function withoutIds(overrides: GuideVideoOverrides, ids: ReadonlyArray<string>): GuideVideoOverrides {
  const drop = new Set(ids);
  return {
    pinned: overrides.pinned.filter((id) => !drop.has(id)),
    hidden: overrides.hidden.filter((id) => !drop.has(id)),
  };
}

function useOverrideSave(notes: AdminResource<GuideAdminNotesPayload>, apiPath: string | null) {
  const { getToken } = useAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<AdminNoticeValue | null>(null);

  async function save(busyKey: string, next: GuideVideoOverrides, done: string) {
    if (!apiPath || busyId) return;
    setBusyId(busyKey);
    setNotice(null);
    try {
      await apiCall<GuideAdminNoteSaveResponse>(getToken, apiPath, { method: "PUT", body: JSON.stringify({ videos: next } satisfies GuideAdminNoteSaveBody) });
      await notes.mutate();
      setNotice({ tone: "success", text: done });
    } catch (err) {
      setNotice({ tone: "error", text: adminErrorText("Couldn't save this guide's videos.", err) });
    } finally {
      setBusyId(null);
    }
  }

  return { busyId, notice, save };
}

/**
 * Per-guide video choices for the selected build: pin (shown first,
 * ≤ 3) or hide on this guide only (≤ 20). Saved through the notes PUT
 * as `{ videos: { pinned, hidden } }` — the API merges, so the notes
 * body is untouched.
 */
export function GuideVideoOverridesCard({ videos, notes, selection }: GuideVideoOverridesProps) {
  const note = notes.data?.items.find((n) => guideNoteKey(n.matchup, n.buildKey) === guideNoteKey(selection.matchup, selection.buildKey));
  const overrides = note?.videos ?? EMPTY_OVERRIDES;
  const candidates = useMemo(() => overrideCandidates(videos, selection, overrides), [videos, selection, overrides]);
  const missing = useMemo(() => missingOverrideIds(videos, overrides), [videos, overrides]);
  const apiPath = guideNoteApiPath(selection.matchup, selection.buildKey);
  const { busyId, notice, save } = useOverrideSave(notes, apiPath);
  const name = guideDisplayName(selection.buildKey);
  const disabled = !apiPath || !notes.data || Boolean(notes.error) || Boolean(busyId);

  return (
    <Card>
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 id={HEADING_ID} className="text-body font-semibold text-text">On the {selection.matchup} {name} guide</h3>
          <p className="text-caption text-text-muted">
            The guide shows up to three videos: pinned ones first, then automatic matches, newest first. Pin up to {GUIDE_VIDEO_PINNED_MAX}; hide up to {GUIDE_VIDEO_HIDDEN_MAX} on this guide only.
          </p>
        </div>
        <AdminNotice notice={notice} />
        {candidates.length === 0 ? (
          <p className="text-caption text-text-dim">No channel videos are detected for {selection.matchup} yet. Add one by URL below.</p>
        ) : (
          <ul aria-labelledby={HEADING_ID} className="divide-y divide-border">
            {candidates.map((video) => (
              <OverrideRow
                key={video.youtubeId}
                video={video}
                buildKey={selection.buildKey}
                overrides={overrides}
                disabled={disabled}
                onPin={() => void save(video.youtubeId, togglePinned(overrides, video.youtubeId), overrides.pinned.includes(video.youtubeId) ? `Unpinned “${video.title}”.` : `Pinned “${video.title}” to ${name}.`)}
                onHide={() => void save(video.youtubeId, toggleHidden(overrides, video.youtubeId), overrides.hidden.includes(video.youtubeId) ? `“${video.title}” can show on ${name} again.` : `Hid “${video.title}” on ${name}.`)}
              />
            ))}
          </ul>
        )}
        {missing.length > 0 ? (
          <MissingOverrides ids={missing} disabled={disabled} onClear={() => void save("missing", withoutIds(overrides, missing), `Cleared ${missing.length} unknown video ${missing.length === 1 ? "id" : "ids"} from ${name}.`)} />
        ) : null}
      </div>
    </Card>
  );
}

function MissingOverrides({ ids, disabled, onClear }: { ids: ReadonlyArray<string>; disabled: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-caption text-warning">
        Pinned or hidden here but not in the channel list (still counted toward the caps): <span className="font-mono">{ids.join(", ")}</span>
      </p>
      <Button size="sm" variant="secondary" className="shrink-0" disabled={disabled} onClick={onClear}>Clear them</Button>
    </div>
  );
}

function OverrideRow({
  video,
  buildKey,
  overrides,
  disabled,
  onPin,
  onHide,
}: {
  video: GuideAdminVideo;
  buildKey: string;
  overrides: GuideVideoOverrides;
  disabled: boolean;
  onPin: () => void;
  onHide: () => void;
}) {
  const pinned = overrides.pinned.includes(video.youtubeId);
  const hidden = overrides.hidden.includes(video.youtubeId);
  const pinFull = !pinned && overrides.pinned.length >= GUIDE_VIDEO_PINNED_MAX;
  const hideFull = !hidden && overrides.hidden.length >= GUIDE_VIDEO_HIDDEN_MAX;
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="break-words text-body font-medium text-text">{video.title}</p>
        <OverrideBadges pinned={pinned} hidden={hidden} autoMatch={video.builds.includes(buildKey)} hiddenEverywhere={video.hidden} />
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant={pinned ? "primary" : "secondary"} aria-pressed={pinned} aria-label={`Pin “${video.title}”`} disabled={disabled || pinFull} onClick={onPin}>Pin</Button>
        <Button size="sm" variant={hidden ? "primary" : "secondary"} aria-pressed={hidden} aria-label={`Hide here “${video.title}”`} disabled={disabled || hideFull} onClick={onHide}>Hide here</Button>
      </div>
    </li>
  );
}

function OverrideBadges({
  pinned,
  hidden,
  autoMatch,
  hiddenEverywhere,
}: {
  pinned: boolean;
  hidden: boolean;
  autoMatch: boolean;
  hiddenEverywhere: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {pinned ? <Badge variant="accent" size="sm">Pinned</Badge> : null}
      {hidden ? <Badge variant="warning" size="sm">Hidden on this guide</Badge> : null}
      {autoMatch ? <Badge variant="cyan" size="sm">Auto match</Badge> : null}
      {hiddenEverywhere ? <Badge variant="danger" size="sm">Hidden everywhere</Badge> : null}
    </div>
  );
}
