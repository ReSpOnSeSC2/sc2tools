/**
 * TEST FIXTURES ONLY for the admin Guides page tests. Videos reuse the
 * real channel snapshot fixtures (lib/guides/__fixtures__/videos.ts) plus
 * the detection the API produces for them (§8 expected matches). The
 * status numbers are synthetic and exist only in these tests.
 */
import type {
  GuideAdminNote,
  GuideAdminStatusPayload,
  GuideAdminVideo,
  GuideBackfillStatus,
} from "@/lib/guides/types";
import {
  VIDEO_PVT_STARGATE_CHARGE,
  VIDEO_PVZ_CARRIER_RUSH,
  VIDEO_PVZ_CRACKING_8_POOLS,
  VIDEO_PVZ_STARGATE_GLAIVES,
} from "@/lib/guides/__fixtures__";

export const STARGATE_GLAIVES = "PvZ - Stargate into Glaives";
export const STARGATE_GLAIVES_NOTES_PATH = "/v1/admin/guides/notes/pvz/stargate-into-glaives";

export const ADMIN_VIDEO_GLAIVES: GuideAdminVideo = {
  ...VIDEO_PVZ_STARGATE_GLAIVES,
  matchup: "PvZ",
  builds: [STARGATE_GLAIVES],
  counters: [],
  source: "snapshot",
  hidden: false,
  isShort: false,
  eightWorkerPatch: true,
};

export const ADMIN_VIDEO_8_POOLS: GuideAdminVideo = {
  ...VIDEO_PVZ_CRACKING_8_POOLS,
  matchup: "PvZ",
  builds: [],
  counters: [],
  source: "snapshot",
  hidden: false,
  isShort: false,
  eightWorkerPatch: true,
};

export const ADMIN_VIDEO_CARRIERS: GuideAdminVideo = {
  ...VIDEO_PVZ_CARRIER_RUSH,
  matchup: "PvZ",
  builds: ["PvZ - Carrier Rush"],
  counters: [],
  source: "rss",
  hidden: true,
  isShort: false,
  eightWorkerPatch: true,
};

export const ADMIN_VIDEO_PVT_CHARGE: GuideAdminVideo = {
  ...VIDEO_PVT_STARGATE_CHARGE,
  matchup: "PvT",
  builds: ["PvT - Stargate into Charge"],
  counters: [],
  source: "snapshot",
  hidden: false,
  isShort: false,
  eightWorkerPatch: true,
};

export const ADMIN_VIDEOS: GuideAdminVideo[] = [
  ADMIN_VIDEO_CARRIERS,
  ADMIN_VIDEO_PVT_CHARGE,
  ADMIN_VIDEO_GLAIVES,
  ADMIN_VIDEO_8_POOLS,
];

/** A stored note for the Stargate into Glaives guide. */
export function glaivesNote(overrides: Partial<GuideAdminNote> = {}): GuideAdminNote {
  return {
    matchup: "PvZ",
    buildKey: STARGATE_GLAIVES,
    buildSlug: "stargate-into-glaives",
    body: "### Plan\n- Scout before the third",
    updatedAt: "2026-09-20T12:00:00.000Z",
    videos: { pinned: [], hidden: [] },
    ...overrides,
  };
}

export const IDLE_BACKFILL: GuideBackfillStatus = {
  disabled: false,
  running: false,
  days: null,
  since: null,
  startedAt: null,
  finishedAt: null,
  done: false,
  processed: 0,
  written: 0,
  skipped: 0,
  failed: 0,
  lastError: null,
};

/** Synthetic status (tests only). */
export function statusFixture(backfill: Partial<GuideBackfillStatus> = {}): GuideAdminStatusPayload {
  return {
    run: {
      computedAt: "2026-09-27T03:00:00.000Z",
      durationMs: 184000,
      counts: { builds: 120, published: 14, counters: 60, maps: 9 },
    },
    backfill: { ...IDLE_BACKFILL, ...backfill },
    samples: { count: 5120 },
    recompute: { running: false, requestedAt: null, last: null },
  };
}
