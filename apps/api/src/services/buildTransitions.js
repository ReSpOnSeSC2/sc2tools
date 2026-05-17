"use strict";

const { classifyGame } = require("./phaseClassifier");
const {
  PHASE_WINDOWS,
  pickSignatureUnits,
  signatureKey,
} = require("./buildCompositions");

/**
 * buildTransitions — Sankey-shaped routing of a build's games through
 * (col 0) the build itself → (col 1) opponent strategy → (col 2)
 * final phase reached → (col 3) late-game unit composition. Pure
 * compute, no I/O. Caller pre-filters games to a single build and
 * passes them in newest-first (same contract as
 * ``buildCompositions.js`` and ``buildDossier.js``).
 *
 * Columns 0..3 are forward-only — every edge goes from column i to
 * column i+1. Games whose ``finalPhase`` is not "late" terminate at
 * their col 2 node and never emit a col 3 edge. Games whose
 * ``finalPhase`` is "late" pick a single late-composition signature
 * (top-3 non-worker units at the late-window midpoint, same picker
 * the compositions service uses) and route to that col 3 node.
 *
 * Rare-collapse rule: any column-1..3 node with games < 2 is folded
 * into a sibling "Other" node at the same column; any remaining edge
 * with games < 2 (after the node-fold) is dropped from the output.
 * Both counts are reported in ``rare`` so the UI can surface a
 * "+ N rare paths" footer.
 *
 * Time-base note: every timestamp here flows through the same
 * sc2reader event.second scale that the classifier and compositions
 * services use. See ``phaseClassifier.js`` header for the cross-
 * cutting fix tracker.
 */

/** @type {Record<number, "build"|"oppStrategy"|"finalPhase"|"lateComp"|"oppRace">} */
const BUILD_COLUMN_KIND = {
  0: "build",
  1: "oppStrategy",
  2: "finalPhase",
  3: "lateComp",
};

/** @type {Record<number, "build"|"oppStrategy"|"finalPhase"|"lateComp"|"oppRace">} */
const OPPONENT_COLUMN_KIND = {
  0: "build",
  1: "oppRace",
  2: "oppStrategy",
  3: "finalPhase",
};

const OTHER_LABEL = "Other";
const UNKNOWN_STRATEGY = "Unknown";
const UNKNOWN_RACE = "Unknown";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   column: 0|1|2|3,
 *   kind: "build"|"oppStrategy"|"finalPhase"|"lateComp"|"oppRace",
 *   games: number,
 *   wins: number,
 *   losses: number,
 *   iconTokens?: string[],
 * }} TransitionNode
 *
 * @typedef {{
 *   from: string,
 *   to: string,
 *   games: number,
 *   wins: number,
 *   losses: number,
 *   winRate: number,
 * }} TransitionEdge
 */

/**
 * @param {Array<any>} games
 * @param {{ mode?: "build"|"opponent", label?: string, perspective?: "you"|"opponent" }} [opts]
 *   ``mode`` selects the column scheme:
 *     "build" (default) — col 0 build → col 1 oppStrategy →
 *       col 2 finalPhase → col 3 lateComp (variable depth, col 3 only
 *       for late-ending games).
 *     "opponent" — col 0 vs-opponent → col 1 oppRace → col 2 oppStrategy
 *       → col 3 finalPhase (fixed depth; no late-comp column). Used by
 *       the opponent profile so the Sankey reads "this opponent (race
 *       Z) tends to play strategy Y and gets the game to phase X".
 *   ``label`` overrides the col-0 node's display label. In build mode
 *   it defaults to the games' ``myBuild``; in opponent mode it should
 *   be the opponent's display name ("vs <name>") so the col-0 node
 *   labels the profile owner.
 *   ``perspective="opponent"`` (build mode only) flips the classifier
 *   and the col-3 lateComp picker to the opponent's side: phases are
 *   scored off ``opp_*`` lifetimes / stats and the late composition
 *   reads ``unit_timeline[*].opp``. Lets the build-vs-strategy 2-col
 *   comparison render "what they typically do" alongside the user's
 *   side.
 * @returns {{
 *   nodes: TransitionNode[],
 *   edges: TransitionEdge[],
 *   rare: { collapsedNodes: number, collapsedEdges: number },
 * }}
 */
function computeTransitions(games, opts = {}) {
  const list = Array.isArray(games) ? games : [];
  if (list.length === 0) {
    return {
      nodes: [],
      edges: [],
      rare: { collapsedNodes: 0, collapsedEdges: 0 },
    };
  }

  const mode = opts.mode === "opponent" ? "opponent" : "build";
  const columnKind = mode === "opponent" ? OPPONENT_COLUMN_KIND : BUILD_COLUMN_KIND;
  const col0Label = opts.label || pickBuildLabel(list);

  /** @type {Array<{path: TransitionPathNode[], won: boolean, lost: boolean}>} */
  const paths = [];
  for (const g of list) {
    const path = mode === "opponent"
      ? pathForOpponentGame(g, col0Label)
      : pathForGame(g, col0Label, opts.perspective);
    paths.push({
      path,
      won: isWonResult(g && g.result),
      lost: isLossResult(g && g.result),
    });
  }

  const raw = aggregatePaths(paths);

  /** @type {Set<string>} */
  const rareIds = new Set();
  let collapsedNodes = 0;
  for (const col of [1, 2, 3]) {
    for (const n of raw.colMap[col].values()) {
      if (n.games < 2) {
        rareIds.add(n.id);
        collapsedNodes += 1;
      }
    }
  }

  let agg = raw;
  if (rareIds.size > 0) {
    const remapped = paths.map(({ path, won, lost }) => ({
      path: path.map((n) => rerouteRare(n, rareIds, columnKind)),
      won,
      lost,
    }));
    agg = aggregatePaths(remapped);
  }

  let collapsedEdges = 0;
  for (const [key, e] of [...agg.edgeMap]) {
    if (e.games < 2) {
      collapsedEdges += 1;
      agg.edgeMap.delete(key);
    }
  }

  /** @type {TransitionNode[]} */
  const nodes = [];
  for (const col of [0, 1, 2, 3]) {
    const arr = [...agg.colMap[col].values()].sort(sortByGamesDescLabelAsc);
    nodes.push(...arr);
  }

  /** @type {TransitionEdge[]} */
  const edges = [...agg.edgeMap.values()]
    .map(finalizeEdge)
    .sort(sortEdges);

  return { nodes, edges, rare: { collapsedNodes, collapsedEdges } };
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   column: 0|1|2|3,
 *   kind: "build"|"oppStrategy"|"finalPhase"|"lateComp"|"oppRace",
 *   iconTokens?: string[],
 * }} TransitionPathNode
 */

/**
 * @param {Array<any>} list
 */
function pickBuildLabel(list) {
  for (const g of list) {
    const b = (g && (g.myBuild || g.my_build || g.build)) || "";
    if (b) return String(b);
  }
  return "Build";
}

/**
 * Compute the column-0..3 routing for one game. Always returns col 0
 * + col 1 + col 2; only adds col 3 when ``finalPhase`` is "late".
 *
 * @param {any} g
 * @param {string} buildLabel
 * @param {"you"|"opponent"} [perspective]
 * @returns {TransitionPathNode[]}
 */
function pathForGame(g, buildLabel, perspective) {
  const macroBreakdown = (g && g.macroBreakdown) || {};
  const sidePerspective = perspective === "opponent" ? "opponent" : "you";
  const race = sidePerspective === "opponent"
    ? ((g && g.oppRace) || (g && g.myRace))
    : (g && g.myRace);
  const durationSec = (g && g.durationSec) || 0;
  const classified = classifyGame({
    macroBreakdown, race, durationSec, perspective: sidePerspective,
  });
  const finalPhase = classified.finalPhase;

  const rawStrat =
    (g && g.opponent && g.opponent.strategy) ||
    (g && g.opp_strategy) ||
    "";
  const strat = rawStrat ? String(rawStrat) : UNKNOWN_STRATEGY;

  /** @type {TransitionPathNode[]} */
  const path = [
    { id: "build", label: buildLabel, column: 0, kind: "build" },
    {
      id: `strat:${strat}`,
      label: strat,
      column: 1,
      kind: "oppStrategy",
    },
    {
      id: `phase:${finalPhase}`,
      label: finalPhase,
      column: 2,
      kind: "finalPhase",
    },
  ];

  if (finalPhase === "late") {
    const win = lateWindow(classified.crossings, durationSec);
    if (win) {
      const midpoint = (win.start + win.end) / 2;
      const units = pickSignatureUnits(
        macroBreakdown, midpoint, sidePerspective,
      );
      const key = units.length > 0 ? signatureKey(units) : "Unknown";
      /** @type {TransitionPathNode} */
      const node = {
        id: `comp:${key}`,
        label: key,
        column: 3,
        kind: "lateComp",
      };
      if (units.length > 0) {
        node.iconTokens = units.map((u) => u.token);
      }
      path.push(node);
    }
  }

  return path;
}

/**
 * Opponent-mode column routing. Path is always 4 cols:
 *   col 0 vs-opponent → col 1 oppRace → col 2 oppStrategy →
 *   col 3 finalPhase
 *
 * The classifier still scores the game from the profile owner's
 * perspective (``myRace`` + ``macroBreakdown``) — the col-3
 * ``finalPhase`` reads "where this game ended up", which is what the
 * Sankey caption ("this opponent vs me usually does Z and ends in
 * mid/late") names. No col-3 lateComp branch in this mode — the
 * opponent profile surfaces aggregate composition via the trajectory
 * strip, not the Sankey.
 *
 * @param {any} g
 * @param {string} col0Label  display label for the col-0 node — caller
 *   passes e.g. ``vs <opponent name>`` so the node reads correctly.
 * @returns {TransitionPathNode[]}
 */
function pathForOpponentGame(g, col0Label) {
  const macroBreakdown = (g && g.macroBreakdown) || {};
  const race = g && g.myRace;
  const durationSec = (g && g.durationSec) || 0;
  const classified = classifyGame({ macroBreakdown, race, durationSec });
  const finalPhase = classified.finalPhase;

  const rawOppRace =
    (g && g.opponent && g.opponent.race) ||
    (g && g.opp_race) ||
    "";
  const oppRace = rawOppRace ? String(rawOppRace) : UNKNOWN_RACE;

  const rawStrat =
    (g && g.opponent && g.opponent.strategy) ||
    (g && g.opp_strategy) ||
    "";
  const strat = rawStrat ? String(rawStrat) : UNKNOWN_STRATEGY;

  return [
    { id: "opponent", label: col0Label, column: 0, kind: "build" },
    {
      id: `oppRace:${oppRace}`,
      label: oppRace,
      column: 1,
      kind: "oppRace",
    },
    {
      id: `strat:${strat}`,
      label: strat,
      column: 2,
      kind: "oppStrategy",
    },
    {
      id: `phase:${finalPhase}`,
      label: finalPhase,
      column: 3,
      kind: "finalPhase",
    },
  ];
}

/**
 * @param {Record<string, any>} crossings
 * @param {number} durationSec
 */
function lateWindow(crossings, durationSec) {
  const startKey = PHASE_WINDOWS.late.startKey;
  const start = startKey === null ? 0 : crossings[startKey];
  if (start === null || start === undefined) return null;
  return { start, end: durationSec };
}

/**
 * Replace a rare-node reference with the column's "Other" sibling.
 * Col-0 is never rare-checked (it's a single node by construction).
 *
 * @param {TransitionPathNode} n
 * @param {Set<string>} rareIds
 * @param {Record<number, "build"|"oppStrategy"|"finalPhase"|"lateComp"|"oppRace">} columnKind
 *   Per-column kind table for the current mode — picks the right
 *   kind to stamp on the synthetic "Other" node (e.g. col-2 is
 *   ``oppStrategy`` in opponent mode but ``finalPhase`` in build
 *   mode).
 * @returns {TransitionPathNode}
 */
function rerouteRare(n, rareIds, columnKind) {
  if (n.column === 0) return n;
  if (!rareIds.has(n.id)) return n;
  return {
    id: `other:${n.column}`,
    label: OTHER_LABEL,
    column: n.column,
    kind: columnKind[n.column],
  };
}

/**
 * Accumulate paths into node + edge buckets keyed by id / (from, to).
 *
 * @param {Array<{path: TransitionPathNode[], won: boolean, lost: boolean}>} paths
 */
function aggregatePaths(paths) {
  /** @type {Record<number, Map<string, any>>} */
  const colMap = {
    0: new Map(),
    1: new Map(),
    2: new Map(),
    3: new Map(),
  };
  /** @type {Map<string, any>} */
  const edgeMap = new Map();

  for (const { path, won, lost } of paths) {
    for (const n of path) {
      const m = colMap[n.column];
      let b = m.get(n.id);
      if (!b) {
        b = {
          id: n.id,
          label: n.label,
          column: n.column,
          kind: n.kind,
          games: 0,
          wins: 0,
          losses: 0,
        };
        if (n.iconTokens && n.iconTokens.length > 0) {
          b.iconTokens = n.iconTokens.slice();
        }
        m.set(n.id, b);
      }
      b.games += 1;
      if (won) b.wins += 1;
      if (lost) b.losses += 1;
    }
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i].id;
      const to = path[i + 1].id;
      const key = `${from}${to}`;
      let e = edgeMap.get(key);
      if (!e) {
        e = { from, to, games: 0, wins: 0, losses: 0 };
        edgeMap.set(key, e);
      }
      e.games += 1;
      if (won) e.wins += 1;
      if (lost) e.losses += 1;
    }
  }

  return { colMap, edgeMap };
}

/**
 * @param {{from: string, to: string, games: number, wins: number, losses: number}} e
 * @returns {TransitionEdge}
 */
function finalizeEdge(e) {
  const denom = e.wins + e.losses;
  return {
    from: e.from,
    to: e.to,
    games: e.games,
    wins: e.wins,
    losses: e.losses,
    winRate: denom > 0 ? e.wins / denom : 0,
  };
}

/**
 * @param {{games: number, label: string}} a
 * @param {{games: number, label: string}} b
 */
function sortByGamesDescLabelAsc(a, b) {
  if (a.games !== b.games) return b.games - a.games;
  if (a.label < b.label) return -1;
  if (a.label > b.label) return 1;
  return 0;
}

/**
 * @param {{games: number, from: string, to: string}} a
 * @param {{games: number, from: string, to: string}} b
 */
function sortEdges(a, b) {
  if (a.games !== b.games) return b.games - a.games;
  if (a.from < b.from) return -1;
  if (a.from > b.from) return 1;
  if (a.to < b.to) return -1;
  if (a.to > b.to) return 1;
  return 0;
}

/**
 * Result predicates kept local so callers can synthesise game records
 * by hand for tests without pulling in dnaTimings.
 *
 * @param {string} r
 */
function isWonResult(r) {
  return r === "Win" || r === "Victory";
}

/**
 * @param {string} r
 */
function isLossResult(r) {
  if (!r) return false;
  const s = String(r).toLowerCase();
  return s === "loss" || s === "defeat";
}

module.exports = { computeTransitions };
