"use client";

import { useApi } from "@/lib/clientApi";
import type {
  GuideAdminNotesPayload,
  GuideAdminStatusPayload,
  GuideAdminVideosPayload,
} from "@/lib/guides/types";
import {
  GUIDE_NOTES_PATH,
  GUIDE_STATUS_PATH,
  GUIDE_STATUS_POLL_MS,
  GUIDE_VIDEOS_PATH,
  type AdminResource,
} from "./guidesAdminShared";

const HTTP_FORBIDDEN = 403;

/**
 * Poll the status while a recompute or the backfill runs; idle otherwise.
 *
 * Example: `statusPollInterval({ …, backfill: { running: true, … } })` → 5000.
 */
export function statusPollInterval(latest: GuideAdminStatusPayload | undefined): number {
  const busy = Boolean(latest?.backfill?.running) || Boolean(latest?.recompute?.running);
  return busy ? GUIDE_STATUS_POLL_MS : 0;
}

export interface GuidesAdminData {
  notes: AdminResource<GuideAdminNotesPayload>;
  status: AdminResource<GuideAdminStatusPayload>;
  videos: AdminResource<GuideAdminVideosPayload>;
  /** Any admin endpoint answered 403 (not on the admin list). */
  forbidden: boolean;
}

/**
 * The three admin reads of the Guides page, fetched in parallel (the
 * API gates all of them with the same `admin_only` check).
 */
export function useGuidesAdmin(): GuidesAdminData {
  const notes = useApi<GuideAdminNotesPayload>(GUIDE_NOTES_PATH);
  const status = useApi<GuideAdminStatusPayload>(GUIDE_STATUS_PATH, {
    refreshInterval: statusPollInterval,
  });
  const videos = useApi<GuideAdminVideosPayload>(GUIDE_VIDEOS_PATH);
  const forbidden = [notes.error, status.error, videos.error].some(
    (error) => error?.status === HTTP_FORBIDDEN,
  );
  return { notes, status, videos, forbidden };
}
