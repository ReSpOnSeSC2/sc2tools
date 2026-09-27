/**
 * Replay Review Exchange — shared web types and pure helpers
 * (docs/reviews.md). The shapes mirror apps/api/src/services/reviews.js;
 * every public payload is already redacted server-side (no opponent
 * identity, no game id), so nothing here needs to scrub.
 */

export type ReviewsRollout = "off" | "admins" | "on";

/**
 * Build-time rollout flag. Must match the API's REVIEWS_ENABLED; the API
 * is the security boundary, this only decides navigation and pages. Read
 * inside the function (not at module scope) so tests can stub it.
 */
export function reviewsRollout(): ReviewsRollout {
  const value = (process.env.NEXT_PUBLIC_REVIEWS_ENABLED ?? "").trim().toLowerCase();
  if (value === "admins" || value === "admin") return "admins";
  if (value === "true" || value === "on" || value === "all" || value === "1") return "on";
  return "off";
}

/** Whether review surfaces should be offered to this viewer. */
export function reviewsVisible(isAdmin: boolean | undefined): boolean {
  const rollout = reviewsRollout();
  return rollout === "on" || (rollout === "admins" && isAdmin === true);
}

export const REVIEW_LIMITS = {
  QUESTION_MIN: 20,
  QUESTION_MAX: 500,
  COMMENT_MIN: 10,
  COMMENT_MAX: 2000,
  COMMENT_MAX_LINKS: 5,
  MAX_RANGE_SEC: 300,
  EDIT_WINDOW_MS: 15 * 60 * 1000,
  MIN_SYNCED_GAMES: 20,
} as const;

export const REVIEW_TAGS = [
  { key: "build_order", label: "Build order" },
  { key: "macro", label: "Macro" },
  { key: "scouting", label: "Scouting" },
  { key: "army_control", label: "Army control" },
  { key: "decision_making", label: "Decision making" },
  { key: "micro", label: "Micro" },
  { key: "specific_timing", label: "Specific timing" },
] as const;

export type ReviewTag = (typeof REVIEW_TAGS)[number]["key"];

export const DESIRED_LEVELS = [
  { key: "anyone", label: "Anyone" },
  { key: "my_league_or_higher", label: "My league or higher" },
  { key: "masters_plus", label: "Masters+" },
] as const;

export type DesiredLevel = (typeof DESIRED_LEVELS)[number]["key"];

export const LEAGUE_BANDS = [
  { id: 0, label: "Bronze" },
  { id: 1, label: "Silver" },
  { id: 2, label: "Gold" },
  { id: 3, label: "Platinum" },
  { id: 4, label: "Diamond" },
  { id: 5, label: "Master" },
  { id: 6, label: "Grandmaster" },
] as const;

export const MATCHUPS = ["PvP", "PvT", "PvZ", "TvP", "TvT", "TvZ", "ZvP", "ZvT", "ZvZ"] as const;

export type Band = { id: number; label: string };
export type Race = "Protoss" | "Terran" | "Zerg" | "Random";

export type ReviewCard = {
  id: string;
  url: string;
  question: string;
  tags: string[];
  matchup: string | null;
  map: string | null;
  result: "Win" | "Loss" | "Draw" | null;
  durationSec: number | null;
  askerLabel: string;
  askerBand: Band | null;
  desiredLevel: DesiredLevel;
  status: "open" | "answered" | "closed" | "removed";
  reviewCount: number;
  helpfulCount: number;
  hasBest: boolean;
  hasPlayback: boolean;
  createdAt: string | null;
  lastActivityAt: string | null;
  visibility?: "public" | "link";
};

export type ReviewBoardResponse = { items: ReviewCard[]; nextCursor: string | null };

export type ReviewRequestView = {
  id: string;
  url: string;
  question: string;
  tags: string[];
  timeRange: { startSec: number; endSec: number } | null;
  desiredLevel: DesiredLevel;
  visibility: "public" | "link";
  status: "open" | "answered" | "closed" | "removed";
  closedReason: "asker" | "game_unavailable" | "moderator" | "closed" | null;
  hidden: boolean;
  asker: { label: string; anonymous: boolean; band: Band | null; mmr: number | null; isYou: boolean };
  game: {
    matchup: string | null;
    myRace: Race | null;
    oppRace: Race | null;
    map: string | null;
    result: "Win" | "Loss" | "Draw" | null;
    durationSec: number | null;
    myBuild: string | null;
    oppStrategy: string | null;
    macroScore: number | null;
    hasPlayback: boolean;
  };
  opponent: { label: string; race: Race | null; band: Band | null; mmr: number | null };
  stats: { reviewCount: number; commentCount: number; helpfulCount: number; upvoteTotal: number };
  bestCommentId: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
};

export type ReviewerVerified = { band: Band; race: Race | null; mmr: number | null };

export type ReviewCommentAuthor = {
  label: string;
  isAsker: boolean;
  profileHref: string | null;
  verified: ReviewerVerified | null;
  badges: Array<{ key: string; label: string }>;
  flair: string | null;
  coach: { coachId: string; bookable: boolean; isViewersCoach: boolean } | null;
};

export type ReviewComment = {
  id: string;
  parentId: string | null;
  state: "visible" | "hidden" | "removed" | "deleted" | "blocked";
  author: ReviewCommentAuthor | null;
  body: string;
  gameTimeSec: number | null;
  endTimeSec: number | null;
  mapPoint: { x: number; y: number } | null;
  upvotes: number;
  upvoted: boolean;
  helpful: boolean;
  best: boolean;
  mine: boolean;
  canEdit: boolean;
  createdAt: string | null;
  editedAt: string | null;
};

export type ReviewViewer = {
  signedIn: boolean;
  isAsker: boolean;
  isAdmin: boolean;
  canComment: boolean;
  canReview?: boolean;
  reason: null | "sign_in" | "closed" | "blocked" | "min_games" | "level_required" | "browser_session_required";
  syncedGames?: number;
  requiredGames?: number;
  verified?: ReviewerVerified | null;
};

export type ReviewSeo = {
  indexable: boolean;
  answerCount: number;
  acceptedAnswerId: string | null;
  suggestedAnswerIds: string[];
};

export type ReviewPageData = {
  request: ReviewRequestView;
  comments: ReviewComment[];
  viewer: ReviewViewer;
  seo: ReviewSeo;
};

export type ReviewAnalysis = {
  requestId: string;
  game: {
    matchup: string | null;
    myRace: Race | null;
    oppRace: Race | null;
    map: string | null;
    result: string | null;
    durationSec: number | null;
    askerLabel: string;
    opponentLabel: string;
    myBuild: string | null;
    oppStrategy: string | null;
  };
  macroBreakdown: Record<string, unknown> | null;
  buildOrder: Record<string, unknown> | null;
  playback: { mode: "segmented" | "inline" | "none" };
};

export type ReviewerMe = {
  name: string;
  stats: { karma: number; helpful: number; best: number; upvotes: number; reviews: number; removed: number };
  badges: Array<{ key: string; label: string }>;
  flair: string | null;
  verified: ReviewerVerified | null;
  canComment: boolean;
  syncedGames: number;
  requiredGames: number;
  leaderboardOptIn: boolean;
  weeklyDigest: boolean;
};

export type LeaderboardResponse = {
  weekStart: string;
  items: Array<{
    rank: number;
    name: string;
    profileHref: string | null;
    verified: ReviewerVerified | null;
    flair: string | null;
    points: number;
    helpful: number;
    best: number;
  }>;
};

/** m:ss (or h:mm:ss) game clock. */
export function formatClock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Parse "5:12" / "1:05:12" / "312" into seconds; null when invalid. */
export function parseClock(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n > 59)) return null;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}

/** "[PvZ] Why did my blink all-in fail?" */
export function reviewHeadline(question: string, matchup: string | null): string {
  const q = question.replace(/\s+/g, " ").trim();
  const short = q.length > 110 ? `${q.slice(0, 109).trimEnd()}…` : q;
  return matchup ? `[${matchup}] ${short}` : short;
}

export function reviewPageTitle(question: string, matchup: string | null): string {
  return `${reviewHeadline(question, matchup)} — Replay Review · SC2 Tools`;
}

export function validateQuestion(question: string): string | null {
  const length = question.replace(/\s+/g, " ").trim().length;
  if (length < REVIEW_LIMITS.QUESTION_MIN) {
    return `Ask a specific question — at least ${REVIEW_LIMITS.QUESTION_MIN} characters.`;
  }
  if (length > REVIEW_LIMITS.QUESTION_MAX) {
    return `Keep your question under ${REVIEW_LIMITS.QUESTION_MAX} characters.`;
  }
  return null;
}

const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

export type CommentDraft = {
  body: string;
  gameTimeSec: number | null;
  endTimeSec: number | null;
};

/** Mirrors the API's comment rules so the composer can explain them up front. */
export function validateComment(draft: CommentDraft, durationSec: number | null): string | null {
  const length = draft.body.trim().length;
  if (length < REVIEW_LIMITS.COMMENT_MIN) return `Comments need at least ${REVIEW_LIMITS.COMMENT_MIN} characters.`;
  if (length > REVIEW_LIMITS.COMMENT_MAX) return `Comments are limited to ${REVIEW_LIMITS.COMMENT_MAX.toLocaleString("en-US")} characters.`;
  if ((draft.body.match(URL_RE) || []).length > REVIEW_LIMITS.COMMENT_MAX_LINKS) {
    return `Use at most ${REVIEW_LIMITS.COMMENT_MAX_LINKS} links.`;
  }
  if (draft.gameTimeSec === null || !Number.isFinite(draft.gameTimeSec) || draft.gameTimeSec < 0) {
    return "Pick the moment this comment is about.";
  }
  const max = typeof durationSec === "number" ? durationSec + 1 : Number.POSITIVE_INFINITY;
  if (draft.gameTimeSec > max) return "That moment is after the game ended.";
  if (draft.endTimeSec !== null) {
    if (!(draft.endTimeSec > draft.gameTimeSec)) return "The range must end after it starts.";
    if (draft.endTimeSec > max) return "The range must end before the game does.";
    if (draft.endTimeSec - draft.gameTimeSec > REVIEW_LIMITS.MAX_RANGE_SEC) return "Keep ranges to 5 minutes or less.";
  }
  return null;
}

/**
 * Pins numbered in thread order: the Nth pinned comment is "N" on the
 * map, in its card and on the timeline, so the three always agree.
 */
export function pinNumbers(comments: ReviewComment[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const c of comments) {
    if (c.state === "visible" && c.mapPoint) out.set(c.id, (n += 1));
  }
  return out;
}

export type CommentCluster = { startSec: number; count: number; ids: string[] };

/**
 * Timeline marker strip: comments bucketed into fixed-width windows so a
 * busy moment reads as one bigger marker instead of an unreadable pile.
 */
export function commentClusters(
  comments: ReviewComment[],
  durationSec: number,
  bucketSec = 10,
): CommentCluster[] {
  const buckets = new Map<number, CommentCluster>();
  for (const c of comments) {
    if (c.state !== "visible" || c.gameTimeSec === null) continue;
    const t = Math.min(Math.max(0, c.gameTimeSec), Math.max(0, durationSec));
    const start = Math.floor(t / bucketSec) * bucketSec;
    const cluster = buckets.get(start) ?? { startSec: start, count: 0, ids: [] };
    cluster.count += 1;
    cluster.ids.push(c.id);
    buckets.set(start, cluster);
  }
  return [...buckets.values()].sort((a, b) => a.startSec - b.startSec);
}

export type BoardFilters = {
  sort: "hot" | "new" | "top";
  matchup: string | null;
  band: number | null;
  tag: string | null;
  unanswered: boolean;
};

export function parseBoardFilters(sp: Record<string, string | string[] | undefined>): BoardFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const sort = one(sp.sort);
  const matchup = one(sp.matchup);
  const band = Number.parseInt(one(sp.band), 10);
  const tag = one(sp.tag);
  return {
    sort: sort === "new" || sort === "top" ? sort : "hot",
    matchup: (MATCHUPS as readonly string[]).includes(matchup) ? matchup : null,
    band: LEAGUE_BANDS.some((b) => b.id === band) ? band : null,
    tag: REVIEW_TAGS.some((t) => t.key === tag) ? tag : null,
    unanswered: one(sp.unanswered) === "1",
  };
}

/** Query string for both the board URL and the API call (same keys). */
export function boardQuery(filters: BoardFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (filters.sort !== "hot") params.set("sort", filters.sort);
  if (filters.matchup) params.set("matchup", filters.matchup);
  if (filters.band !== null) params.set("band", String(filters.band));
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.unanswered) params.set("unanswered", "1");
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function redditShareUrl(absoluteUrl: string, question: string, matchup: string | null): string {
  const title = `${reviewHeadline(question, matchup)} — timestamped replay review`;
  return `https://www.reddit.com/submit?url=${encodeURIComponent(absoluteUrl)}&title=${encodeURIComponent(title)}`;
}

export function discordShareText(absoluteUrl: string, question: string, matchup: string | null): string {
  return `**${reviewHeadline(question, matchup)}** — timestamped replay review on SC2 Tools\n<${absoluteUrl}>`;
}

export function tagLabel(key: string): string {
  return REVIEW_TAGS.find((t) => t.key === key)?.label ?? key;
}

export function levelLabel(key: string): string {
  return DESIRED_LEVELS.find((l) => l.key === key)?.label ?? key;
}

/** "Unverified" unless the API verified a band from the reviewer's own games. */
export function verifiedLabel(v: ReviewerVerified | null | undefined): string {
  if (!v) return "Unverified";
  return v.race ? `${v.band.label} ${v.race}` : v.band.label;
}
