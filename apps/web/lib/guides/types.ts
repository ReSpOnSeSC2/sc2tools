/**
 * Guide payload types — the web mirror of the public `/v1/guides/*`
 * responses (apps/api/src/routes/guides.js, shaped by services/guides.js
 * over the nightly `guide_stats` docs), plus the community sitemap and the
 * `/v1/admin/guides/*` admin shapes. Keep in lock-step with the API.
 *
 * Every number here is REAL: the API only emits a cell (games, users,
 * wins, win rate, confidence interval) when it clears the cell floor
 * (5 players and 30 games), and unpublished guides carry no numbers at
 * all. Win rates and shares are fractions in 0..1 rounded to 4 dp;
 * `winRate` is over DECIDED games (wins / (wins + losses)), `games`
 * includes ties, `ci` is the 95% Wilson interval over decided games.
 * Timestamps are ISO-8601 strings (JSON-serialised Dates).
 */
import type { GuideMatchup } from "@/lib/guides/slugs";

export type { GuideMatchup } from "@/lib/guides/slugs";

/**
 * "after" = the live 12-worker game (before 5.0.16 and from 5.0.17 on);
 * "before" = the 8-worker patch 5.0.16. A payload's `patch` names the
 * live patch for both eras.
 */
export type GuideEra = "after" | "before";

/** Which opponent-band axis a matchup page is filtered by. */
export type GuideBandType = "league" | "mmr";

/** Stored game result on a guide sample / example replay. */
export type GuideGameResult = "Victory" | "Defeat" | "Tie";

/** Build-log milestone semantics: buildings log at start, morphs/upgrades at completion. */
export type GuideMilestoneEvent = "start" | "finish";

/** Army checkpoints, in whole seconds, as JSON object keys. */
export type GuideArmyCheckpointKey = "360" | "480" | "600";

/** Game-length bucket keys (minutes). */
export type GuideLengthBucketKey = "0-6" | "6-10" | "10-15" | "15-20" | "20+";

/** 95% Wilson interval over decided games (fractions 0..1). */
export interface GuideCi {
  low: number;
  high: number;
}

/** One displayed number group; only emitted when it meets the cell floor. */
export interface GuideCell {
  games: number;
  users: number;
  wins: number;
  winRate: number;
  ci: GuideCi;
}

/** Short alias used across the guide components. */
export type Cell = GuideCell;

/** Week-over-week movement against the ≥ 7-day-old baseline snapshot. */
export interface GuideTrendValue {
  winRateDelta: number;
  /** Null when either side had no prevalence (no matchup total). */
  prevalenceDelta: number | null;
  /** ISO time of the baseline snapshot. */
  since: string;
}

export type GuideTrend = GuideTrendValue | null;

/** A build-order video from the site owner's channel (§8). */
export interface GuideVideo {
  youtubeId: string;
  title: string;
  /**
   * ISO upload time; null for an admin-added video the channel feed hasn't
   * listed yet (the API never guesses a date). No VideoObject is emitted
   * for it, and the date is simply omitted from the UI.
   */
  publishedAt: string | null;
  url: string;
  thumbnailUrl: string;
  embedUrl: string;
  /** First paragraph of the description, verbatim (≤ 300 chars); "" when there is none. */
  excerpt: string | null;
  /** Verbatim checklist lines from the description, or null. */
  checklist: string[] | null;
}

export interface GuideChannel {
  url: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/* GET /v1/guides                                                      */
/* ------------------------------------------------------------------ */

export interface GuideIndexTopBuild {
  buildKey: string;
  buildSlug: string;
  name: string;
  games: number;
  users: number;
  winRate: number;
  ci: GuideCi;
  trend: GuideTrend;
  isNew: boolean;
}

export interface GuideIndexMatchup {
  matchup: GuideMatchup;
  slug: string;
  published: boolean;
  games: number | null;
  users: number | null;
  /** ≤ 3 published builds, ci.low desc. */
  top: GuideIndexTopBuild[];
  publishedBuilds: number;
}

export interface GuideIndexMap {
  map: string;
  slug: string;
  games: number;
}

export interface GuideIndexPayload {
  computedAt: string | null;
  era: GuideEra;
  patch: string;
  matchups: GuideIndexMatchup[];
  /** Published maps only, games desc. */
  maps: GuideIndexMap[];
  /** ≤ 4 latest build-order videos. */
  videos: GuideVideo[];
  channel: GuideChannel | null;
}

/* ------------------------------------------------------------------ */
/* GET /v1/guides/:matchup                                             */
/* ------------------------------------------------------------------ */

export interface GuideBand {
  type: GuideBandType;
  value: number;
  label: string;
}

export interface GuideBandOption {
  value: number;
  label: string;
}

export interface GuideBandOptions {
  league: GuideBandOption[];
  mmr: GuideBandOption[];
}

export interface GuideOpenerRow extends GuideCell {
  buildKey: string;
  buildSlug: string;
  name: string;
  published: boolean;
  prevalence: number | null;
  trend: GuideTrend;
  isNew: boolean;
}

export interface GuideCounterLink {
  strategyKey: string;
  strategySlug: string;
  name: string;
  published: boolean;
  games: number | null;
}

export interface GuideMatchupPayload {
  matchup: GuideMatchup;
  slug: string;
  era: GuideEra;
  patch: string;
  /** Null only before the first nightly run. */
  computedAt: string | null;
  published: boolean;
  games: number | null;
  users: number | null;
  band: GuideBand | null;
  /** Only bands with at least one published cell. */
  bandOptions: GuideBandOptions;
  /** ci.low desc; with a band, the band cell per build (builds without one omitted). */
  openers: GuideOpenerRow[];
  counters: GuideCounterLink[];
  /** ≤ 4 latest videos for the matchup. */
  videos: GuideVideo[];
}

/* ------------------------------------------------------------------ */
/* GET /v1/guides/:matchup/:build                                      */
/* ------------------------------------------------------------------ */

export interface GuideHeadline {
  /** "league" = the densest league band clearing the cell floor; else "all". */
  scope: "league" | "all";
  value: number | null;
  label: string | null;
  games: number;
  winRate: number;
}

export interface GuideBandCell extends GuideCell {
  value: number;
  label: string;
}

export interface GuideBandCells {
  league: GuideBandCell[];
  mmr: GuideBandCell[];
}

export interface GuideMilestoneSplit {
  games: number;
  users: number;
  median: number;
}

export interface GuideMilestone {
  /** Stable identifier, e.g. "Pylon", "Nexus#2", "BlinkTech". */
  key: string;
  /** Human label, e.g. "2nd Nexus", "Blink". */
  label: string;
  event: GuideMilestoneEvent;
  games: number;
  users: number;
  /** Share of samples that reached the milestone (≥ 0.6 to be shown). */
  presence: number;
  /** Recorded build-log seconds. */
  p25: number;
  median: number;
  p75: number;
  /** Present only when BOTH winners and losers meet the cell floor. */
  winners?: GuideMilestoneSplit;
  losers?: GuideMilestoneSplit;
}

export interface GuideTimings {
  samples: number;
  users: number;
  milestones: GuideMilestone[];
}

export interface GuideArmyUnit {
  unit: string;
  presence: number;
  median: number;
  games: number;
}

export interface GuideArmyCheckpoint {
  samples: number;
  users: number;
  units: GuideArmyUnit[];
}

/** A checkpoint is absent when no sample carried it. */
export type GuideArmy = Partial<Record<GuideArmyCheckpointKey, GuideArmyCheckpoint>>;

export interface GuideVsStrategyRow extends GuideCell {
  strategyKey: string;
  strategySlug: string;
  name: string;
  published: boolean;
}

export interface GuideLengthRow extends GuideCell {
  bucket: GuideLengthBucketKey;
  minSec: number;
  maxSec: number | null;
}

export interface GuideMapCell extends GuideCell {
  map: string;
  mapSlug: string;
}

export interface GuideMacro {
  avgScore: number;
  games: number;
  users: number;
}

export interface GuideLeakItem {
  name: string;
  games: number;
  users: number;
  share: number;
}

export interface GuideLeaks {
  games: number;
  users: number;
  items: GuideLeakItem[];
}

export interface GuideRelatedBuild {
  buildKey: string;
  buildSlug: string;
  name: string;
  published: boolean;
  games: number;
  winRate: number;
  ci: GuideCi;
}

export interface GuideCommunityBuildLink {
  slug: string;
  title: string;
}

export interface GuideExampleReplay {
  handle: string;
  displayName: string | null;
  result: GuideGameResult;
  map: string | null;
  durationSec: number | null;
  playedAt: string;
  /** "/players/<handle>/replays". */
  href: string;
}

export interface GuideNotes {
  body: string;
  updatedAt: string;
}

interface GuideBuildBase {
  matchup: GuideMatchup;
  matchupSlug: string;
  /** Exact catalog name, e.g. "PvZ - Stargate into Glaives". */
  buildKey: string;
  buildSlug: string;
  /** Display name, e.g. "Stargate into Glaives". */
  name: string;
  /** Catalog detection-rule prose, verbatim. */
  description: string;
  era: GuideEra;
  patch: string;
  computedAt: string | null;
  /** The owner's videos are real content, so they ship even unpublished. */
  videos: GuideVideo[];
}

/** Below the page floor: no numbers at all. */
export interface GuideBuildUnpublished extends GuideBuildBase {
  published: false;
}

export interface GuideBuildPublished extends GuideBuildBase {
  published: true;
  overall: GuideCell;
  prevalence: number | null;
  matchupGames: number | null;
  headline: GuideHeadline | null;
  bands: GuideBandCells;
  timings: GuideTimings | null;
  army: GuideArmy | null;
  vsStrategy: GuideVsStrategyRow[];
  lengths: GuideLengthRow[];
  maps: GuideMapCell[];
  macro: GuideMacro | null;
  leaks: GuideLeaks | null;
  trend: GuideTrend;
  isNew: boolean;
  firstPublishedAt: string | null;
  /** Same matchup, published first, ≤ 8. */
  related: GuideRelatedBuild[];
  /** ≤ 3 exact-name community builds. */
  communityBuilds: GuideCommunityBuildLink[];
  /** ≤ 3, re-verified sharing users only. */
  examples: GuideExampleReplay[];
  notes: GuideNotes | null;
}

export type GuideBuildPayload = GuideBuildUnpublished | GuideBuildPublished;

/* ------------------------------------------------------------------ */
/* GET /v1/guides/:matchup/counter/:strategy                           */
/* ------------------------------------------------------------------ */

export interface GuideCounterOpener extends GuideCell {
  buildKey: string;
  buildSlug: string;
  name: string;
  published: boolean;
}

interface GuideCounterBase {
  matchup: GuideMatchup;
  matchupSlug: string;
  /** Exact opponent-strategy catalog name, e.g. "Zerg - 12 Pool". */
  strategyKey: string;
  strategySlug: string;
  name: string;
  description: string;
  /** Viewer race and opponent race as the API labels them. */
  myRace: string;
  oppRace: string;
  era: GuideEra;
  patch: string;
  computedAt: string | null;
  videos: GuideVideo[];
}

export interface GuideCounterUnpublished extends GuideCounterBase {
  published: false;
}

export interface GuideCounterPublished extends GuideCounterBase {
  published: true;
  overall: GuideCell;
  /** ci.low desc. */
  openers: GuideCounterOpener[];
}

export type GuideCounterPayload = GuideCounterUnpublished | GuideCounterPublished;

/* ------------------------------------------------------------------ */
/* GET /v1/guides/maps/:map                                            */
/* ------------------------------------------------------------------ */

export interface GuideMapOpener extends GuideCell {
  buildKey: string;
  buildSlug: string;
  name: string;
}

export interface GuideMapMatchupRow extends GuideCell {
  matchup: GuideMatchup;
  slug: string;
  /** Top 3 by ci.low. */
  openers: GuideMapOpener[];
}

interface GuideMapBase {
  map: string;
  mapSlug: string;
  era: GuideEra;
  patch: string;
  computedAt: string | null;
}

export interface GuideMapUnpublished extends GuideMapBase {
  published: false;
}

export interface GuideMapPublished extends GuideMapBase {
  published: true;
  games: number;
  matchups: GuideMapMatchupRow[];
}

export type GuideMapPayload = GuideMapUnpublished | GuideMapPublished;

/* ------------------------------------------------------------------ */
/* GET /v1/guides/sitemap and GET /v1/guides/me/:matchup/:build        */
/* ------------------------------------------------------------------ */

export interface GuideSitemapEntry {
  /** Site path, e.g. "/guides/pvz/stargate-into-glaives". */
  path: string;
  lastModified: string;
}

export interface GuideSitemapPayload {
  computedAt: string | null;
  entries: GuideSitemapEntry[];
}

export interface GuideMeMilestone {
  key: string;
  label: string;
  event: GuideMilestoneEvent;
  median: number;
  games: number;
}

/** The signed-in caller's own numbers (never cached, never shared). */
export interface GuideMePayload {
  matchup: GuideMatchup;
  buildKey: string;
  era: GuideEra;
  games: number;
  wins: number;
  losses: number;
  winRate: number | null;
  timings: {
    samples: number;
    milestones: GuideMeMilestone[];
  };
}

/* ------------------------------------------------------------------ */
/* GET /v1/community/sitemap (public; app/sitemap.ts)                  */
/* ------------------------------------------------------------------ */

export interface CommunitySitemapBuild {
  slug: string;
  lastModified: string;
}

export interface CommunitySitemapProfile {
  handle: string;
  lastModified: string;
}

/** Non-removed community builds and their authors' public profiles (≤ 10,000 each). */
export interface CommunitySitemapPayload {
  builds: CommunitySitemapBuild[];
  profiles: CommunitySitemapProfile[];
}

/* ------------------------------------------------------------------ */
/* /v1/admin/guides/* (admin only; `private, no-store`)                */
/* ------------------------------------------------------------------ */

/** Per-guide video overrides stored on the coach's note (youtube ids). */
export interface GuideVideoOverrides {
  /** Shown first, ≤ 3. */
  pinned: string[];
  /** Never shown on this guide, ≤ 20. */
  hidden: string[];
}

/** One coach's note (never carries the editor's identity). */
export interface GuideAdminNote {
  matchup: GuideMatchup;
  buildKey: string;
  buildSlug: string;
  body: string;
  updatedAt: string;
  videos?: GuideVideoOverrides;
}

/** GET /v1/admin/guides/notes. */
export interface GuideAdminNotesPayload {
  items: GuideAdminNote[];
}

/**
 * PUT /v1/admin/guides/notes/:matchup/:build request body. The API
 * MERGES: an absent field keeps the stored value, so the notes editor
 * sends only `body` and the videos panel only `videos` (at least one).
 */
export type GuideAdminNoteSaveBody =
  | { /** ≤ GUIDE_NOTE_MAX_CHARS (4000). */ body: string; videos?: GuideVideoOverrides }
  | { body?: string; videos: GuideVideoOverrides };

/** PUT /v1/admin/guides/notes/:matchup/:build response. */
export interface GuideAdminNoteSaveResponse {
  note: GuideAdminNote;
}

/** The last nightly recompute. */
export interface GuideRunSummary {
  computedAt: string;
  durationMs: number;
  counts: {
    builds: number;
    published: number;
    counters: number;
    maps: number;
  };
}

/** guide_samples backfill job progress (counts only); also the 202 body of POST /v1/admin/guides/backfill. */
export interface GuideBackfillStatus {
  disabled: boolean;
  running: boolean;
  days: number | null;
  since: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  done: boolean;
  processed: number;
  written: number;
  skipped: number;
  failed: number;
  /** Reason code ("lock_held", "lock_lost", "run_failed"), never a message with ids. */
  lastError: string | null;
}

/** State of the admin "Recompute now" runs (reason codes only). */
export interface GuideRecomputeState {
  running: boolean;
  /** ISO time of the last "Recompute now" since the API started. */
  requestedAt: string | null;
  last: { ran: boolean; reason: string | null; finishedAt: string } | null;
}

/** GET /v1/admin/guides/status. */
export interface GuideAdminStatusPayload {
  run: GuideRunSummary | null;
  backfill: GuideBackfillStatus | null;
  samples: { count: number };
  /** Sent by routes/adminGuides.js (beyond the §6 contract). */
  recompute?: GuideRecomputeState;
}

/** Where a video row came from. */
export type GuideVideoSource = "rss" | "snapshot" | "admin";

/** GET /v1/admin/guides/videos row: public video + detection + moderation. */
export interface GuideAdminVideo extends GuideVideo {
  matchup: GuideMatchup | null;
  /** Detected (and curated) catalog build names. */
  builds: string[];
  /** Detected catalog opponent-strategy names. */
  counters: string[];
  source: GuideVideoSource;
  /** Hidden from every guide. */
  hidden: boolean;
  /** A YouTube Short (never auto-matched to a guide). */
  isShort?: boolean;
  /**
   * Published during the 8-worker patch 5.0.16: never auto-matched to the
   * 12-worker guides, shown on a build guide only when pinned.
   */
  eightWorkerPatch?: boolean;
}

export interface GuideAdminVideosPayload {
  items: GuideAdminVideo[];
}

/** POST /v1/admin/guides/videos (201) and PATCH …/videos/:youtubeId (200). */
export interface GuideAdminVideoResponse {
  item: GuideAdminVideo;
}

/** POST /v1/admin/guides/videos/sync. */
export interface GuideVideoSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
}
