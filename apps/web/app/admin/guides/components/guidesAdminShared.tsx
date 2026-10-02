"use client";

import type { ReactNode } from "react";
import type { ClientApiError } from "@/lib/clientApi";
import { guideBuildOptions, guideBuildSlug } from "@/lib/guides/slugs";
import type { GuideMatchup, GuideVideoOverrides } from "@/lib/guides/types";

/**
 * Shared constants, pure helpers and tiny presentational pieces of the
 * admin Guides page (`/admin/guides`). Paths mirror
 * apps/api/src/routes/adminGuides.js; limits mirror the API validators
 * (validation/guideAdmin.js, jobs/guideSamplesBackfillJob.js).
 */

export const GUIDES_ADMIN_BASE = "/v1/admin/guides";
export const GUIDE_NOTES_PATH = `${GUIDES_ADMIN_BASE}/notes`;
export const GUIDE_STATUS_PATH = `${GUIDES_ADMIN_BASE}/status`;
export const GUIDE_RECOMPUTE_PATH = `${GUIDES_ADMIN_BASE}/recompute`;
export const GUIDE_BACKFILL_PATH = `${GUIDES_ADMIN_BASE}/backfill`;
export const GUIDE_VIDEOS_PATH = `${GUIDES_ADMIN_BASE}/videos`;
export const GUIDE_VIDEOS_SYNC_PATH = `${GUIDE_VIDEOS_PATH}/sync`;

/** Per-guide override caps (services/guideVideoSelect.js). */
export const GUIDE_VIDEO_PINNED_MAX = 3;
export const GUIDE_VIDEO_HIDDEN_MAX = 20;

/**
 * Badge on a video from the 8-worker patch 5.0.16. A build guide shows it
 * as a video guide only when pinned; otherwise it sits in the collapsed
 * 8-worker patch list of the hub, its matchup and the guides it matches.
 */
export const EIGHT_WORKER_BADGE = "8-worker patch · in the 8-worker list unless pinned";

/** Backfill window in days (jobs/guideSamplesBackfillJob.js). */
export const BACKFILL_DAYS_MIN = 1;
export const BACKFILL_DAYS_MAX = 400;
export const BACKFILL_DAYS_DEFAULT = 90;

/** Status poll cadence while a recompute or backfill is running. */
export const GUIDE_STATUS_POLL_MS = 5000;

const HTTP_FORBIDDEN = 403;
const DEFAULT_MATCHUP: GuideMatchup = "PvZ";

/** The guide the notes editor and the per-guide video overrides act on. */
export interface GuideSelection {
  matchup: GuideMatchup;
  /** Exact catalog build name ("" only if a matchup had no builds). */
  buildKey: string;
}

/** SWR result slice the panels consume (a `useApi` return fits it). */
export interface AdminResource<T> {
  data?: T;
  error?: ClientApiError;
  isLoading: boolean;
  mutate: () => Promise<unknown>;
}

export interface AdminNoticeValue {
  tone: "success" | "error";
  text: string;
}

export const EMPTY_OVERRIDES: GuideVideoOverrides = { pinned: [], hidden: [] };

/**
 * First build of a matchup (catalog order), as a selection.
 *
 * Example: `selectionFor("PvZ").matchup` → "PvZ".
 */
export function selectionFor(matchup: GuideMatchup = DEFAULT_MATCHUP): GuideSelection {
  return { matchup, buildKey: guideBuildOptions(matchup)[0]?.name ?? "" };
}

/** Map key of one guide's note. */
export function guideNoteKey(matchup: string, buildKey: string): string {
  return `${matchup}\u0000${buildKey}`;
}

/**
 * Admin notes URL for a guide build, or null when the name is not a
 * guide build of that matchup.
 *
 * Example: `guideNoteApiPath("PvZ", "PvZ - Stargate into Glaives")` →
 * "/v1/admin/guides/notes/pvz/stargate-into-glaives".
 */
export function guideNoteApiPath(matchup: string, buildKey: string): string | null {
  const slug = guideBuildSlug(matchup, buildKey);
  return slug ? `${GUIDE_NOTES_PATH}/${matchup.toLowerCase()}/${slug}` : null;
}

/** Admin URL of one channel video. */
export function guideVideoApiPath(youtubeId: string): string {
  return `${GUIDE_VIDEOS_PATH}/${encodeURIComponent(youtubeId)}`;
}

/**
 * Backfill window from the days input, clamped to 1–400 (blank or junk →
 * the 90-day default).
 *
 * Example: `clampBackfillDays("999")` → 400; `clampBackfillDays("0")` → 1.
 */
export function clampBackfillDays(raw: string): number {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value)) return BACKFILL_DAYS_DEFAULT;
  return Math.min(BACKFILL_DAYS_MAX, Math.max(BACKFILL_DAYS_MIN, value));
}

/**
 * Drafts after an edit of one guide's notes. A draft equal to the stored
 * body is dropped, so reverting an edit clears the "unsaved" state.
 *
 * Example: `withDraft({}, "k", "### Plan", "")` → `{ k: "### Plan" }`;
 * `withDraft({ k: "x" }, "k", "stored", "stored")` → `{}`.
 */
export function withDraft(
  drafts: Readonly<Record<string, string>>,
  key: string,
  value: string,
  storedBody: string,
): Record<string, string> {
  const next = { ...drafts };
  if (value === storedBody) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Toggle a video's pin on one guide. Pinning un-hides it (the API rejects
 * a video that is both pinned and hidden); the pin cap is enforced by
 * the caller disabling the button.
 */
export function togglePinned(overrides: GuideVideoOverrides, youtubeId: string): GuideVideoOverrides {
  if (overrides.pinned.includes(youtubeId)) {
    return { pinned: overrides.pinned.filter((id) => id !== youtubeId), hidden: overrides.hidden };
  }
  return {
    pinned: [...overrides.pinned, youtubeId],
    hidden: overrides.hidden.filter((id) => id !== youtubeId),
  };
}

/** Toggle a video's per-guide hide (hiding un-pins it). */
export function toggleHidden(overrides: GuideVideoOverrides, youtubeId: string): GuideVideoOverrides {
  if (overrides.hidden.includes(youtubeId)) {
    return { pinned: overrides.pinned, hidden: overrides.hidden.filter((id) => id !== youtubeId) };
  }
  return {
    pinned: overrides.pinned.filter((id) => id !== youtubeId),
    hidden: [...overrides.hidden, youtubeId],
  };
}

/** Human copy for the admin guides API's error codes. */
const ERROR_COPY: Readonly<Record<string, string>> = {
  guide_stats_disabled: "Guide stats are switched off on this server (SC2TOOLS_GUIDE_STATS_DISABLED).",
  backfill_disabled: "The samples backfill is switched off on this server (SC2TOOLS_GUIDE_BACKFILL_DISABLED or the samples kill switch).",
  channel_not_configured: "No YouTube channel is configured on the API (GUIDES_YOUTUBE_CHANNEL_ID).",
  video_not_on_channel: "That video isn't on the configured YouTube channel.",
  invalid_video_id: "That isn't a valid YouTube video id.",
  not_found: "That guide or video no longer exists.",
  feed_empty: "The channel feed came back empty.",
};

const ERROR_PREFIX_COPY: ReadonlyArray<[string, string]> = [
  ["video_lookup_", "YouTube couldn't confirm that video. It may be private or removed, or YouTube is unreachable."],
  ["feed_", "Couldn't read the channel feed from YouTube. Try again in a few minutes."],
];

function isClientApiError(err: unknown): err is ClientApiError {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { status?: unknown; message?: unknown };
  return typeof candidate.status === "number" && typeof candidate.message === "string";
}

function copyForCode(code: string | undefined): string | null {
  if (!code) return null;
  const exact = ERROR_COPY[code];
  if (exact) return exact;
  const prefixed = ERROR_PREFIX_COPY.find(([prefix]) => code.startsWith(prefix));
  return prefixed ? prefixed[1] : null;
}

/**
 * Error text for a failed admin call: `lead` plus the API's reason.
 *
 * Example: `adminErrorText("Couldn't add the video.", { status: 422,
 * code: "video_not_on_channel", message: "" })` → "Couldn't add the
 * video. That video isn't on the configured YouTube channel."
 */
export function adminErrorText(lead: string, err: unknown): string {
  if (!isClientApiError(err)) return `${lead} Try again in a moment.`;
  if (err.status === HTTP_FORBIDDEN) return `${lead} Your account isn't an admin.`;
  return `${lead} ${copyForCode(err.code) ?? err.message}`;
}

/** Success (role=status) or error (role=alert) notice; nothing when null. */
export function AdminNotice({ notice }: { notice: AdminNoticeValue | null }) {
  if (!notice) return null;
  if (notice.tone === "error") {
    return (
      <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-body text-danger">
        {notice.text}
      </p>
    );
  }
  return (
    <p role="status" className="rounded-lg border border-success/30 bg-success/5 p-3 text-body text-success">
      {notice.text}
    </p>
  );
}

/** h2 + description + optional actions for one page section. */
export function AdminSectionHeader({
  id,
  title,
  description,
  actions,
}: {
  id: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-2xl space-y-1">
        <h2 id={id} className="text-h3 font-bold">{title}</h2>
        <p className="text-body text-text-muted">{description}</p>
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export const ADMIN_TEXTAREA_CLASS =
  "block w-full resize-y rounded-lg border-2 border-line bg-bg-surface px-3 py-2 font-mono text-caption text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";
