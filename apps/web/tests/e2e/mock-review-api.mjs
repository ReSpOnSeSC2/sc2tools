// Fixture API for the Playwright responsive smoke (tests/e2e).
//
// The suite otherwise runs with NO API: public pages must degrade to
// their "unavailable" states. This stand-in keeps that contract for
// every route by DROPPING the connection (a network failure, exactly
// like the absent API) — except the public Replay Review Exchange
// routes, which answer from the fixtures below so the review board and
// a review page can be exercised signed out, at every viewport, and the
// four public guide routes in ./mock-guides-api.mjs (hub, PvZ matchup,
// one build guide, guide sitemap).
//
// All data here is synthetic test fixture data (a made-up question and
// comments on a fake map); the redaction shape mirrors the real API
// (the opponent only appears as "Opponent (Zerg, ~4,100 MMR)").

import http from "node:http";
import { GUIDE_ROUTES } from "./mock-guides-api.mjs";

const PORT = Number(process.env.MOCK_API_PORT || 8080);
const ID = "e2eReviewFixture";
const NOW = "2026-09-27T12:00:00.000Z";

const REQUEST = {
  id: ID,
  url: `/reviews/${ID}`,
  question: "Why did my blink all-in fail against the roach defence at 6:00? I scouted the roach warren late.",
  tags: ["build_order", "army_control"],
  timeRange: { startSec: 300, endSec: 420 },
  desiredLevel: "anyone",
  visibility: "public",
  status: "answered",
  closedReason: null,
  hidden: false,
  asker: { label: "Anonymous Protoss", anonymous: true, band: { id: 4, label: "Diamond" }, mmr: 4100, isYou: false },
  game: {
    matchup: "PvZ", myRace: "Protoss", oppRace: "Zerg", map: "Fixture Station LE", result: "Loss",
    durationSec: 600, myBuild: "PvZ - Blink All-in", oppStrategy: "Zerg - Roach Ravager", macroScore: 61, hasPlayback: true,
  },
  opponent: { label: "Opponent (Zerg, ~4,100 MMR)", race: "Zerg", band: { id: 4, label: "Diamond" }, mmr: 4100 },
  stats: { reviewCount: 3, commentCount: 4, helpfulCount: 1, upvoteTotal: 6 },
  bestCommentId: "e2eComment000001",
  replay: { shared: true, available: true },
  createdAt: NOW,
  lastActivityAt: NOW,
};

const author = (label, extra = {}) => ({
  label, isAsker: false, profileHref: null,
  verified: { band: { id: 5, label: "Master" }, race: "Protoss", mmr: 4800 },
  badges: [{ key: "first_review", label: "First Review" }], flair: null, ...extra,
});
const comment = (id, t, body, extra = {}) => ({
  id, parentId: null, state: "visible", author: author("FixtureReviewer"), body, gameTimeSec: t, endTimeSec: null,
  mapPoint: null, upvotes: 0, upvoted: false, helpful: false, best: false, mine: false, canEdit: false,
  createdAt: NOW, editedAt: null, ...extra,
});

const COMMENTS = [
  comment("e2eComment000001", 312,
    "Your **blink timing** at 5:12 was too late — the roaches were already out. Scout the natural at 4:30 and hold the blink until 5:40.",
    { endTimeSec: 340, mapPoint: { x: 100, y: 100 }, best: true, upvotes: 4, author: author("MasterFox", { flair: "Masters Mentor" }) }),
  comment("e2eComment000002", 250,
    "- Probe count stalled at 38\n- No observer before the push\n\nThat's why the roach count surprised you.",
    { helpful: true, upvotes: 2, mapPoint: { x: 60, y: 60 }, author: author("MacroMachine", { verified: { band: { id: 4, label: "Diamond" }, race: "Protoss", mmr: 4100 } }) }),
  comment("e2eComment000003", 400, "Retreating at 6:40 would have saved the stalkers; the fight at 6:20 was lost to ravager biles.", { author: author("Unverified Joe", { verified: null, badges: [] }) }),
  { ...comment("e2eComment000004", 312, "Thanks — I'll scout earlier next time."), parentId: "e2eComment000001", author: { ...author("Anonymous Protoss"), isAsker: true, verified: null, badges: [] } },
];

const PAGE = {
  request: REQUEST,
  comments: COMMENTS,
  viewer: { signedIn: false, isAsker: false, isAdmin: false, canComment: false, reason: "sign_in" },
  seo: { indexable: true, answerCount: 3, acceptedAnswerId: "e2eComment000001", suggestedAnswerIds: ["e2eComment000002"] },
};

const CARD = {
  id: ID, url: REQUEST.url, question: REQUEST.question, tags: REQUEST.tags, matchup: "PvZ", map: REQUEST.game.map,
  result: "Loss", durationSec: 600, askerLabel: "Anonymous Protoss", askerBand: REQUEST.asker.band, desiredLevel: "anyone",
  status: "answered", reviewCount: 3, helpfulCount: 1, hasBest: true, hasPlayback: true, replayShared: true, createdAt: NOW, lastActivityAt: NOW,
};

const wp = (t0, x, y) => [t0, x, y, 600, x, y];
const PLAYBACK = {
  ok: true, v: 5, mapName: REQUEST.game.map, gameLength: 600,
  bounds: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
  spawns: [{ owner: "me", x: 30, y: 30 }, { owner: "opp", x: 170, y: 170 }],
  battles: [{ t: 380, x: 100, y: 100 }],
  buildings: [
    { owner: "me", name: "Nexus", t: 0, x: 30, y: 30, moves: [], died: null },
    { owner: "me", name: "Gateway", t: 60, x: 40, y: 32, moves: [], died: null },
    { owner: "opp", name: "Hatchery", t: 0, x: 170, y: 170, moves: [], died: null },
    { owner: "opp", name: "RoachWarren", t: 180, x: 160, y: 168, moves: [], died: null },
  ],
  units: [
    { owner: "me", name: "Probe", born: 0, died: null, wp: wp(0, 32, 30) },
    { owner: "me", name: "Stalker", born: 240, died: 390, wp: wp(240, 90, 95) },
    { owner: "opp", name: "Drone", born: 0, died: null, wp: wp(0, 168, 170) },
    { owner: "opp", name: "Roach", born: 260, died: null, wp: wp(260, 110, 105) },
  ],
  resources: [], casts: [],
  stats: {
    me: [{ t: 0, army: 0, workers: 12, supply: 12 }, { t: 300, army: 2400, workers: 38, supply: 70 }],
    opp: [{ t: 0, army: 0, workers: 12, supply: 12 }, { t: 300, army: 2600, workers: 44, supply: 80 }],
  },
};

const ANALYSIS = {
  requestId: ID,
  game: { ...REQUEST.game, askerLabel: "Anonymous Protoss", opponentLabel: REQUEST.opponent.label },
  macroBreakdown: { ok: true, stats_events: [], opp_stats_events: [] },
  buildOrder: null,
  playback: { mode: "inline" },
};

const ROUTES = new Map([
  ["/v1/reviews", { items: [CARD], nextCursor: null }],
  ["/v1/reviews/leaderboard", { weekStart: NOW, items: [{ rank: 1, name: "MasterFox", profileHref: null, verified: { band: { id: 5, label: "Master" }, race: "Protoss", mmr: 4800 }, flair: "Masters Mentor", points: 20, helpful: 1, best: 1 }] }],
  ["/v1/reviews/sitemap", { items: [{ id: ID, lastModified: NOW }] }],
  [`/v1/reviews/${ID}`, PAGE],
  [`/v1/reviews/${ID}/analysis`, ANALYSIS],
  [`/v1/reviews/${ID}/analysis/map-playback`, PLAYBACK],
  [`/v1/reviews/${ID}/og`, { id: ID, question: REQUEST.question, matchup: "PvZ", map: REQUEST.game.map, result: "Loss", askerBand: "Diamond", reviewCount: 3, hasBest: true, status: "answered" }],
  ...GUIDE_ROUTES,
]);

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
  };
  if (path === "/__mock/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method === "OPTIONS" && path.startsWith("/v1/reviews")) {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method === "GET" && ROUTES.has(path)) {
    res.writeHead(200, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(ROUTES.get(path)));
    return;
  }
  if (req.method === "GET" && path.startsWith("/v1/reviews/")) {
    res.writeHead(404, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "review_not_found", message: "Not found" } }));
    return;
  }
  // Everything else behaves exactly like the absent API.
  req.socket.destroy();
});

server.listen(PORT, () => {
  process.stdout.write(`mock review API on :${PORT}\n`);
});
