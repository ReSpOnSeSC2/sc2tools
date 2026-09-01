"use strict";

/** @typedef {'P'|'T'|'Z'} RaceCode */
/** @typedef {Record<string, any>} LooseRecord */
/** @typedef {{name: string, key: string, atSec: number}} Milestone */
/** @typedef {Milestone[]} MilestoneSet */
/** @typedef {{weight: number, target: number, candidate: number}} ComponentSample */
/**
 * @typedef {{
 *   key: string,
 *   docs: LooseRecord[],
 *   pulseIds: Set<string>,
 *   characterIds: Set<string>,
 *   games: LooseRecord[],
 *   race: RaceCode|null,
 *   representative?: LooseRecord,
 *   name?: string,
 * }} CandidateGroup
 */
/**
 * @typedef {{
 *   buildGames: number,
 *   controlGroupGames: number,
 *   evidenceMode: string,
 * }} EvidenceSummary
 */
/** @typedef {{accountId?: string|null, proId?: string|null, proNickname?: string|null}} CharacterLink */

/**
 * Private replay-behavior identity matcher for unresolved barcode opponents.
 *
 * Scope and privacy
 * -----------------
 * Candidate names come only from the signed-in user's own ``opponents`` and
 * ``games`` rows. Behavioral deanonymization is sensitive; this service never
 * searches another user's plaintext opponent history and never powers the
 * public community profile.
 *
 * Evidence
 * --------
 * New/reprocessed replays carry ``opponent.playSignature`` with bounded
 * logical control-group habits and opening milestones. Legacy rows still
 * contribute their classified ``strategy`` / ``opening`` labels. Missing
 * evidence remains missing and component weights are re-normalized.
 *
 * Probability language
 * --------------------
 * ``patternMatch`` is raw behavioral closeness. ``likelihood`` is an open-set
 * heuristic share across every searched candidate plus an explicit unknown
 * hypothesis; it is deliberately marked ``calibrated: false``. The UI must
 * keep those two values separate and call the latter an estimate, not proof.
 */

const TARGET_GAME_LIMIT = 20;
const CANDIDATE_DOCUMENT_LIMIT = 500;
const CANDIDATE_GAME_SCAN_LIMIT = 12_000;
const GAMES_PER_CANDIDATE_LIMIT = 24;
const MILESTONE_GAME_SAMPLE_LIMIT = 8;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 5;
const MIN_CREDIBLE_PATTERN_MATCH = 0.35;
const METHODOLOGY_VERSION = "behavior_match_v1";
const DEFAULT_PULSE_LINK_DEADLINE_MS = 350;

/** @type {Readonly<Record<string, number>>} */
const COMPONENT_WEIGHTS = Object.freeze({
  buildOrders: 0.55,
  controlGroups: 0.45,
});

/** @type {Readonly<Record<RaceCode, string>>} */
const RACE_NAMES = Object.freeze({ P: "Protoss", T: "Terran", Z: "Zerg" });

class OpponentIdentityMatcherService {
  /**
   * @param {{opponents: import('mongodb').Collection, games: import('mongodb').Collection}} db
   * @param {{
   *   now?: () => Date,
   *   logger?: any,
   *   pulseLinks?: import('./pulseCharacterLinks').PulseCharacterLinkService|null,
   *   pulseLinkDeadlineMs?: number,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.now = typeof opts.now === "function" ? opts.now : () => new Date();
    this.logger = opts.logger || null;
    this.pulseLinks = opts.pulseLinks || null;
    this.pulseLinkDeadlineMs = Number.isFinite(opts.pulseLinkDeadlineMs)
      ? Math.max(25, Math.min(1_000, Number(opts.pulseLinkDeadlineMs)))
      : DEFAULT_PULSE_LINK_DEADLINE_MS;
  }

  /**
   * @param {string} userId
   * @param {string} pulseId
   * @param {{limit?: number}} [opts]
   * @returns {Promise<Record<string, any>|null>}
   */
  async findCandidates(userId, pulseId, opts = {}) {
    const cleanPulseId = cleanString(pulseId);
    if (!cleanPulseId) return null;
    const limit = clampResultLimit(opts.limit);
    const targetDoc = await this.db.opponents.findOne(
      { userId, pulseId: cleanPulseId },
      { projection: IDENTITY_DOCUMENT_PROJECTION },
    );
    if (!targetDoc) return null;

    const eligibility = identityEligibility(targetDoc);
    const base = {
      status: "not_eligible",
      calibrated: false,
      methodologyVersion: METHODOLOGY_VERSION,
      generatedAt: this.now().toISOString(),
      eligibility,
      target: targetSummary(targetDoc, []),
      candidates: [],
      unknownLikelihood: 1,
      otherCandidatesLikelihood: 0,
      otherLikelihood: 0,
      scope: {
        source: "your_replay_history",
        searchedOpponents: 0,
        searchedGames: 0,
        truncated: false,
      },
    };
    if (!eligibility.eligible) return base;

    const allTargetGames = await this._targetGames(userId, targetDoc);
    // The newest replay is authoritative for race. Opponent aggregates store
    // only one last-known race, so preferring that row would contaminate a
    // race-switching/Random player's signature with games from another race.
    const replayRace = allTargetGames
      .map((game) => canonicalRace(game?.opponent?.race))
      .find(Boolean) || null;
    const targetRace = replayRace || canonicalRace(targetDoc.race);
    const targetGames = replayRace
      ? allTargetGames.filter(
          (game) => canonicalRace(game?.opponent?.race) === targetRace,
        )
      : allTargetGames;
    const target = targetSummary(targetDoc, targetGames, targetRace);
    if (!targetRace) {
      return {
        ...base,
        status: "insufficient_data",
        target,
        insufficiency: {
          code: "race_missing",
          message: "The replay does not identify this opponent's race yet.",
        },
      };
    }

    const targetEvidence = summarizeEvidence(targetGames);
    if (targetEvidence.buildGames === 0 && targetEvidence.controlGroupGames === 0) {
      return {
        ...base,
        status: "insufficient_data",
        target: { ...target, ...targetEvidence },
        insufficiency: {
          code: "target_signature_missing",
          message:
            "Re-sync this replay to extract build and control-group evidence.",
        },
      };
    }

    const candidateDocsResult = await this._candidateDocuments(
      userId,
      targetDoc,
    );
    const links = await this._candidateLinks(
      [...candidateDocsResult.documents, targetDoc],
    );
    const groups = buildCandidateGroups(
      candidateDocsResult.documents,
      targetDoc,
      links,
      targetRace,
    );
    if (groups.length === 0) {
      return {
        ...base,
        status: "no_candidates",
        target: { ...target, ...targetEvidence },
        insufficiency: {
          code: "known_same_race_profiles_missing",
          message: `No readable ${RACE_NAMES[targetRace]} profiles are available in your replay history yet.`,
        },
        scope: {
          ...base.scope,
          searchedOpponents: 0,
          truncated: candidateDocsResult.truncated,
        },
      };
    }

    const scan = await this._candidateGames(userId, targetRace, groups);
    const comparableGroups = groups.filter((group) => group.games.length > 0);
    const targetFacingRace = canonicalRace(targetGames[0]?.myRace);
    /** @type {Array<Record<string, any>>} */
    const scored = [];
    for (const group of comparableGroups) {
      const score = scoreCandidate(
        targetGames,
        group.games,
        targetFacingRace,
      );
      if (!score || score.patternMatch < MIN_CREDIBLE_PATTERN_MATCH) continue;
      scored.push({
        ...publicCandidateIdentity(group),
        ...score,
      });
    }

    if (scored.length === 0) {
      return {
        ...base,
        status: "no_candidates",
        target: { ...target, ...targetEvidence },
        insufficiency: {
          code: "comparable_evidence_missing",
          message:
            "Known same-race opponents exist, but none has enough comparable replay evidence yet.",
        },
        scope: {
          source: "your_replay_history",
          searchedOpponents: comparableGroups.length,
          searchedGames: scan.games,
          truncated: candidateDocsResult.truncated || scan.truncated,
        },
      };
    }

    const probabilityMass = attachOpenSetLikelihoods(scored, targetEvidence);
    scored.sort(candidateSort);
    /** @type {LooseRecord[]} */
    const top = scored.slice(0, limit).map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    }));
    const visibleMass = top.reduce(
      (sum, candidate) => sum + finiteOr(candidate.likelihood, 0),
      0,
    );
    const hiddenCandidateMass = scored.reduce(
      (sum, candidate) => sum + finiteOr(candidate.likelihood, 0),
      0,
    ) - visibleMass;

    return {
      ...base,
      status: "ready",
      target: {
        ...target,
        ...targetEvidence,
        matchup: targetFacingRace
          ? `${targetRace}v${targetFacingRace}`
          : null,
      },
      candidates: top,
      unknownLikelihood: probabilityMass.unknownLikelihood,
      otherCandidatesLikelihood: round4(clamp01(hiddenCandidateMass)),
      // Known candidates below the visible top five. Kept separate from the
      // explicit unknown hypothesis so the probability display is auditable.
      otherLikelihood: round4(clamp01(hiddenCandidateMass)),
      scope: {
        source: "your_replay_history",
        searchedOpponents: comparableGroups.length,
        searchedGames: scan.games,
        truncated: candidateDocsResult.truncated || scan.truncated,
      },
    };
  }

  /**
   * @param {string} userId
   * @param {LooseRecord} targetDoc
   * @returns {Promise<LooseRecord[]>}
   */
  async _targetGames(userId, targetDoc) {
    const identity = opponentIdentityClauses(targetDoc);
    if (identity.length === 0) return [];
    return this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          $or: identity,
        },
        { projection: MATCH_GAME_PROJECTION },
      )
      .sort({ date: -1 })
      .limit(TARGET_GAME_LIMIT)
      .toArray();
  }

  /**
   * @param {string} userId
   * @param {LooseRecord} targetDoc
   * @returns {Promise<{documents: LooseRecord[], truncated: boolean}>}
   */
  async _candidateDocuments(userId, targetDoc) {
    const rows = await this.db.opponents
      .find(
        {
          userId,
          pulseId: { $ne: targetDoc.pulseId },
        },
        { projection: IDENTITY_DOCUMENT_PROJECTION },
      )
      .sort({ lastSeen: -1 })
      .limit(CANDIDATE_DOCUMENT_LIMIT + 1)
      .toArray();
    return {
      documents: rows.slice(0, CANDIDATE_DOCUMENT_LIMIT),
      truncated: rows.length > CANDIDATE_DOCUMENT_LIMIT,
    };
  }

  /**
   * @param {LooseRecord[]} documents
   * @returns {Promise<Map<string, CharacterLink>>}
   */
  async _candidateLinks(documents) {
    if (!this.pulseLinks) return new Map();
    const characterIds = documents
      .map((doc) => cleanString(doc?.pulseCharacterId))
      .filter((id) => id !== null);
    if (characterIds.length === 0) return new Map();
    // Linkage is an optional dedupe enhancement, never a reason to make an
    // unresolved-barcode profile wait on SC2Pulse's eight-second network
    // timeout. Cached hits normally finish inside this short deadline; a miss
    // keeps warming the shared cache in the background for the next request.
    const lookup = this.pulseLinks.getLinks(characterIds).catch((err) => {
      this.logger?.warn?.({ err }, "opponent_identity_links_failed");
      return null;
    });
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timeoutId;
    const deadline = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(null), this.pulseLinkDeadlineMs);
    });
    const result = await Promise.race([lookup, deadline]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (!result) {
      this.logger?.debug?.(
        { characterIds: characterIds.length, deadlineMs: this.pulseLinkDeadlineMs },
        "opponent_identity_links_deferred",
      );
      return new Map();
    }
    return result.links instanceof Map ? result.links : new Map();
  }

  /**
   * @param {string} userId
   * @param {RaceCode} race
   * @param {CandidateGroup[]} groups
   * @returns {Promise<{games: number, truncated: boolean}>}
   */
  async _candidateGames(userId, race, groups) {
    const byPulse = new Map();
    const byCharacter = new Map();
    for (const group of groups) {
      for (const id of group.pulseIds) byPulse.set(id, group);
      for (const id of group.characterIds) byCharacter.set(id, group);
    }
    const identityClauses = [];
    if (byPulse.size > 0) {
      identityClauses.push({
        "opponent.pulseId": { $in: [...byPulse.keys()] },
      });
    }
    if (byCharacter.size > 0) {
      identityClauses.push({
        "opponent.pulseCharacterId": { $in: [...byCharacter.keys()] },
      });
    }
    if (identityClauses.length === 0) return { games: 0, truncated: false };
    const rows = await this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          "opponent.race": { $in: raceVariants(race) },
          $or: identityClauses,
        },
        { projection: MATCH_GAME_PROJECTION },
      )
      .sort({ date: -1 })
      .limit(CANDIDATE_GAME_SCAN_LIMIT + 1)
      .toArray();
    for (const game of rows.slice(0, CANDIDATE_GAME_SCAN_LIMIT)) {
      const charId = cleanString(game?.opponent?.pulseCharacterId);
      const candidatePulseId = cleanString(game?.opponent?.pulseId);
      const group = (charId && byCharacter.get(charId))
        || (candidatePulseId && byPulse.get(candidatePulseId));
      if (!group || group.games.length >= GAMES_PER_CANDIDATE_LIMIT) continue;
      group.games.push(game);
    }
    return {
      games: Math.min(rows.length, CANDIDATE_GAME_SCAN_LIMIT),
      truncated: rows.length > CANDIDATE_GAME_SCAN_LIMIT,
    };
  }
}

const IDENTITY_DOCUMENT_PROJECTION = Object.freeze({
  _id: 0,
  pulseId: 1,
  pulseCharacterId: 1,
  toonHandle: 1,
  displayNameSample: 1,
  revealedName: 1,
  race: 1,
  mmr: 1,
  leagueId: 1,
  region: 1,
  gameCount: 1,
  lastSeen: 1,
});

const MATCH_GAME_PROJECTION = Object.freeze({
  _id: 0,
  gameId: 1,
  date: 1,
  myRace: 1,
  gameBuild: 1,
  "opponent.pulseId": 1,
  "opponent.pulseCharacterId": 1,
  "opponent.race": 1,
  "opponent.mmr": 1,
  "opponent.opening": 1,
  "opponent.strategy": 1,
  "opponent.playSignature": 1,
});

/**
 * @param {LooseRecord} doc
 * @returns {LooseRecord}
 */
function identityEligibility(doc) {
  const rawName = cleanString(doc?.displayNameSample) || "";
  const revealedName = readableName(doc?.revealedName);
  const isBarcode = isBarcodeLikeName(rawName);
  const pulseResolved = Boolean(cleanString(doc?.pulseCharacterId));
  const mmrPresent = validMmr(doc?.mmr) !== null;
  const reasons = [];
  if (!pulseResolved) reasons.push("pulse_unresolved");
  if (!mmrPresent) reasons.push("mmr_missing");
  return {
    eligible: isBarcode && !revealedName && reasons.length > 0,
    isBarcode,
    pulseResolved,
    mmrPresent,
    reasons,
  };
}

/**
 * @param {LooseRecord} doc
 * @param {LooseRecord[]} games
 * @param {RaceCode|null|undefined} [forcedRace]
 * @returns {LooseRecord}
 */
function targetSummary(doc, games, forcedRace) {
  const race = forcedRace || canonicalRace(doc?.race)
    || canonicalRace(games[0]?.opponent?.race);
  return {
    pulseId: cleanString(doc?.pulseId),
    name: cleanString(doc?.displayNameSample),
    race: race ? RACE_NAMES[race] : null,
    raceCode: race,
    games: games.length,
  };
}

/**
 * @param {LooseRecord[]} games
 * @returns {EvidenceSummary}
 */
function summarizeEvidence(games) {
  let buildGames = 0;
  let controlGroupGames = 0;
  for (const game of games) {
    if (gameHasBuildEvidence(game)) buildGames += 1;
    if (validControlGroups(game?.opponent?.playSignature?.controlGroups)) {
      controlGroupGames += 1;
    }
  }
  return {
    buildGames,
    controlGroupGames,
    evidenceMode:
      buildGames > 0 && controlGroupGames > 0
        ? "build_and_control_groups"
        : controlGroupGames > 0
          ? "control_groups_only"
          : buildGames > 0
            ? "build_only"
            : "none",
  };
}

/**
 * @param {LooseRecord[]} documents
 * @param {LooseRecord} targetDoc
 * @param {Map<string, CharacterLink>} [links]
 * @param {RaceCode|null} [race]
 * @returns {CandidateGroup[]}
 */
function buildCandidateGroups(documents, targetDoc, links = new Map(), race = null) {
  const targetPulseId = cleanString(targetDoc?.pulseId);
  const targetCharacterId = cleanString(targetDoc?.pulseCharacterId);
  const targetLinkKey = linkGroupKey(
    targetCharacterId ? links.get(targetCharacterId) : null,
  );
  /** @type {Map<string, CandidateGroup>} */
  const byKey = new Map();
  for (const doc of documents) {
    const pulseId = cleanString(doc?.pulseId);
    const characterId = cleanString(doc?.pulseCharacterId);
    if (!pulseId || pulseId === targetPulseId) continue;
    if (targetCharacterId && characterId === targetCharacterId) continue;
    const linkedKey = linkGroupKey(characterId ? links.get(characterId) : null);
    if (targetLinkKey && linkedKey === targetLinkKey) continue;
    const key = linkedKey
      || (characterId ? `character:${characterId}` : `pulse:${pulseId}`);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        docs: [],
        pulseIds: new Set(),
        characterIds: new Set(),
        games: [],
        race,
      };
      byKey.set(key, group);
    }
    group.docs.push(doc);
    group.pulseIds.add(pulseId);
    if (characterId) group.characterIds.add(characterId);
  }
  /** @type {CandidateGroup[]} */
  const out = [];
  for (const group of byKey.values()) {
    group.docs.sort((a, b) => dateValue(b.lastSeen) - dateValue(a.lastSeen));
    const representative = group.docs.find(
      (doc) => readableName(doc.revealedName) || readableName(doc.displayNameSample),
    );
    if (!representative) continue;
    const name = readableName(representative.revealedName)
      || readableName(representative.displayNameSample);
    if (!name) continue;
    group.representative = representative;
    group.name = name;
    out.push(group);
  }
  return out;
}

/**
 * @param {CandidateGroup} group
 * @returns {LooseRecord}
 */
function publicCandidateIdentity(group) {
  const doc = /** @type {LooseRecord} */ (group.representative);
  const groupRace = canonicalRace(group.race);
  const docRace = canonicalRace(doc.race);
  const candidateGames = /** @type {LooseRecord[]} */ (group.games);
  const sameRaceReplayMmr = candidateGames
    .map((game) => validMmr(game?.opponent?.mmr))
    .find((mmr) => mmr !== null) ?? null;
  // The aggregate is last-known across all races. A Random/race-switching
  // account must not show another race's rating beside this match.
  const aggregateMmr = groupRace && docRace === groupRace
    ? validMmr(doc.mmr)
    : null;
  return {
    pulseId: cleanString(doc.pulseId),
    pulseCharacterId: cleanString(doc.pulseCharacterId),
    name: group.name,
    race: (groupRace ? RACE_NAMES[groupRace] : null)
      || (docRace ? RACE_NAMES[docRace] : null)
      || cleanString(doc.race),
    region: cleanString(doc.region),
    mmr: sameRaceReplayMmr ?? aggregateMmr,
    gamesInProfile: boundedCount(
      group.docs.reduce(
        (total, profile) => total + boundedCount(profile.gameCount),
        0,
      ),
    ),
  };
}

/**
 * @param {LooseRecord[]} targetGames
 * @param {LooseRecord[]} candidateGames
 * @param {RaceCode|null} targetFacingRace
 * @returns {LooseRecord|null}
 */
function scoreCandidate(targetGames, candidateGames, targetFacingRace) {
  const buildOrders = buildOrderComponent(
    targetGames,
    candidateGames,
    targetFacingRace,
  );
  const controlGroups = controlGroupComponent(targetGames, candidateGames);
  /** @type {Record<string, LooseRecord|null>} */
  const components = { buildOrders, controlGroups };
  let weighted = 0;
  let availableWeight = 0;
  for (const [key, component] of Object.entries(components)) {
    if (!component || !Number.isFinite(component.score)) continue;
    const weight = COMPONENT_WEIGHTS[key];
    weighted += component.score * weight;
    availableWeight += weight;
  }
  if (availableWeight <= 0) return null;
  const patternMatch = clamp01(weighted / availableWeight);
  const coverage = clamp01(availableWeight);
  /** @type {ComponentSample[]} */
  const componentSamples = Object.entries(components).flatMap(
    ([key, component]) => component
      ? [{
          weight: COMPONENT_WEIGHTS[key],
          target: component.targetSamples || 0,
          candidate: component.candidateSamples || 0,
        }]
      : [],
  );
  const targetSamples = Math.max(0, ...componentSamples.map((row) => row.target));
  const candidateSamples = Math.max(
    0,
    ...componentSamples.map((row) => row.candidate),
  );
  const reliability = evidenceReliability(componentSamples, coverage);
  const rankScore = 0.5 + (patternMatch - 0.5) * reliability;
  return {
    patternMatch: round4(patternMatch),
    rankScore: round6(rankScore),
    confidence: confidenceBand({
      targetSamples,
      candidateSamples,
      coverage,
      patternMatch,
      componentSamples,
    }),
    evidenceQuality: round4(reliability),
    sample: {
      targetGames: targetGames.length,
      candidateGames: candidateGames.length,
      targetEvidenceGames: targetSamples,
      candidateEvidenceGames: candidateSamples,
    },
    evidence: {
      buildOrders,
      controlGroups,
      coverage: round4(coverage),
    },
    caveats: candidateCaveats(buildOrders, controlGroups, targetSamples),
  };
}

/**
 * @param {LooseRecord[]} targetGames
 * @param {LooseRecord[]} candidateGames
 * @param {RaceCode|null} targetFacingRace
 * @returns {LooseRecord|null}
 */
function buildOrderComponent(targetGames, candidateGames, targetFacingRace) {
  let target = targetGames.filter(gameHasBuildEvidence);
  let candidate = candidateGames.filter(gameHasBuildEvidence);
  if (targetFacingRace) {
    target = target.filter(
      (game) => canonicalRace(game.myRace) === targetFacingRace,
    );
    candidate = candidate.filter(
      (game) => canonicalRace(game.myRace) === targetFacingRace,
    );
  }
  if (target.length === 0 || candidate.length === 0) return null;

  const strategy = distributionOverlap(
    target.map((game) => game?.opponent?.strategy),
    candidate.map((game) => game?.opponent?.strategy),
  );
  const opening = distributionOverlap(
    target.map((game) => game?.opponent?.opening),
    candidate.map((game) => game?.opponent?.opening),
  );
  const targetMilestones = target
    .map((game) => validMilestones(game?.opponent?.playSignature?.build?.milestones))
    .filter((rows) => rows.length > 0)
    .slice(0, MILESTONE_GAME_SAMPLE_LIMIT);
  const candidateMilestones = candidate
    .map((game) => validMilestones(game?.opponent?.playSignature?.build?.milestones))
    .filter((rows) => rows.length > 0)
    .slice(0, MILESTONE_GAME_SAMPLE_LIMIT);
  const milestones = targetMilestones.length > 0 && candidateMilestones.length > 0
    ? prototypeSetSimilarity(targetMilestones, candidateMilestones)
    : null;

  /** @type {{value: number|null, weight: number}[]} */
  const measures = [
    { value: milestones, weight: 0.55 },
    { value: strategy, weight: 0.30 },
    { value: opening, weight: 0.15 },
  ].filter(
    (item) => typeof item.value === "number" && Number.isFinite(item.value),
  );
  if (measures.length === 0) return null;
  const denominator = measures.reduce((sum, item) => sum + item.weight, 0);
  const score = measures.reduce(
    (sum, item) => sum + finiteOr(item.value, 0) * item.weight,
    0,
  ) / denominator;
  const sharedBuilds = sharedLabels(
    target.map((game) => game?.opponent?.strategy),
    candidate.map((game) => game?.opponent?.strategy),
    3,
  );
  const sharedMilestones = milestoneHighlights(
    targetMilestones,
    candidateMilestones,
    4,
  );
  const highlights = [];
  if (sharedBuilds.length > 0) {
    highlights.push(
      `${sharedBuilds.length === 1 ? "Shared build" : "Shared builds"}: ${sharedBuilds.join(", ")}`,
    );
  }
  for (const row of sharedMilestones.slice(0, 2)) {
    highlights.push(`${row.name} timing within ${row.deltaSec}s`);
  }
  return {
    score: round4(clamp01(score)),
    targetSamples: target.length,
    candidateSamples: candidate.length,
    milestoneSamples: {
      target: targetMilestones.length,
      candidate: candidateMilestones.length,
    },
    sharedBuilds,
    sharedMilestones,
    highlights,
  };
}

/**
 * @param {LooseRecord[]} targetGames
 * @param {LooseRecord[]} candidateGames
 * @returns {LooseRecord|null}
 */
function controlGroupComponent(targetGames, candidateGames) {
  const target = aggregateControlGroups(targetGames);
  const candidate = aggregateControlGroups(candidateGames);
  if (!target || !candidate) return null;

  const recall = jsSimilarity(target.recall, candidate.recall);
  const actions = cosineSimilarity(target.actions, candidate.actions);
  const activeSlots = jaccardSimilarity(target.activeSlots, candidate.activeSlots);
  const transitions = cosineSimilarity(target.transitions, candidate.transitions);
  const doubleTap = ratioSimilarity(target.doubleTapRate, candidate.doubleTapRate);
  const eventRate = ratioSimilarity(target.eventsPerMinute, candidate.eventsPerMinute);
  /** @type {{value: number|null, weight: number}[]} */
  const measures = [
    { value: recall, weight: 0.35 },
    { value: actions, weight: 0.20 },
    { value: activeSlots, weight: 0.15 },
    { value: transitions, weight: 0.15 },
    { value: doubleTap, weight: 0.075 },
    { value: eventRate, weight: 0.075 },
  ].filter(
    (item) => typeof item.value === "number" && Number.isFinite(item.value),
  );
  if (measures.length === 0) return null;
  const denominator = measures.reduce((sum, item) => sum + item.weight, 0);
  const score = measures.reduce(
    (sum, item) => sum + finiteOr(item.value, 0) * item.weight,
    0,
  ) / denominator;
  const primaryTarget = topVectorIndices(target.recall, 3);
  const primaryCandidate = new Set(topVectorIndices(candidate.recall, 4));
  const matchedSlots = primaryTarget.filter((slot) => primaryCandidate.has(slot));
  const highlights = [];
  if (matchedSlots.length > 0) {
    highlights.push(
      `Same primary control ${matchedSlots.length === 1 ? "group" : "groups"}: ${matchedSlots.join(", ")}`,
    );
  }
  if (doubleTap !== null && doubleTap >= 0.85) {
    highlights.push("Similar control-group double-tap rhythm");
  }
  if (eventRate !== null && eventRate >= 0.85) {
    highlights.push("Similar control-group activity rate");
  }
  return {
    score: round4(clamp01(score)),
    targetSamples: target.samples,
    candidateSamples: candidate.samples,
    matchedSlots,
    highlights,
  };
}

/**
 * @param {LooseRecord[]} games
 * @returns {LooseRecord|null}
 */
function aggregateControlGroups(games) {
  const recall = Array(10).fill(0);
  const actions = Array(30).fill(0);
  const transitions = Array(100).fill(0);
  const activeSlots = new Set();
  let events = 0;
  let activeSeconds = 0;
  let doubleTaps = 0;
  let recalls = 0;
  let samples = 0;
  for (const game of games) {
    const control = game?.opponent?.playSignature?.controlGroups;
    if (!validControlGroups(control)) continue;
    samples += 1;
    events += boundedCount(control.events);
    activeSeconds += Math.max(1, boundedCount(control.activeSeconds));
    for (const row of control.slots) {
      const slot = integerInRange(row?.slot, 0, 9);
      if (slot === null) continue;
      const set = boundedCount(row.set);
      const add = boundedCount(row.add);
      const recallCount = boundedCount(row.recall);
      const doubleTapCount = boundedCount(row.doubleTap);
      actions[slot * 3] += set;
      actions[slot * 3 + 1] += add;
      actions[slot * 3 + 2] += recallCount;
      recall[slot] += recallCount;
      recalls += recallCount;
      doubleTaps += doubleTapCount;
      if (set + add + recallCount > 0) activeSlots.add(slot);
    }
    for (const row of Array.isArray(control.transitions) ? control.transitions : []) {
      const from = integerInRange(row?.from, 0, 9);
      const to = integerInRange(row?.to, 0, 9);
      if (from === null || to === null) continue;
      transitions[from * 10 + to] += boundedCount(row.count);
    }
  }
  if (samples === 0) return null;
  return {
    samples,
    recall,
    actions,
    transitions,
    activeSlots,
    doubleTapRate: doubleTaps / Math.max(1, recalls),
    eventsPerMinute: events / Math.max(1 / 60, activeSeconds / 60),
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validControlGroups(value) {
  const record = /** @type {LooseRecord|null} */ (
    value && typeof value === "object" ? value : null
  );
  return Boolean(
    record
    && Array.isArray(record.slots)
    && record.slots.length > 0,
  );
}

/**
 * @param {LooseRecord} game
 * @returns {boolean}
 */
function gameHasBuildEvidence(game) {
  return Boolean(
    validBehaviorLabel(game?.opponent?.strategy)
    || validBehaviorLabel(game?.opponent?.opening)
    || validMilestones(game?.opponent?.playSignature?.build?.milestones).length,
  );
}

/**
 * @param {unknown} rows
 * @returns {Milestone[]}
 */
function validMilestones(rows) {
  if (!Array.isArray(rows)) return [];
  /** @type {Milestone[]} */
  const out = [];
  for (const row of rows.slice(0, 18)) {
    const name = cleanString(row?.name);
    const atSec = finiteNumber(row?.atSec);
    if (!name || atSec === null || atSec < 0 || atSec > 600) continue;
    out.push({ name, key: canonicalBuildToken(name), atSec });
  }
  return out.filter((row) => row.key);
}

/**
 * @param {MilestoneSet[]} left
 * @param {MilestoneSet[]} right
 * @returns {number}
 */
function prototypeSetSimilarity(left, right) {
  /**
   * @param {MilestoneSet[]} source
   * @param {MilestoneSet[]} candidates
   * @returns {number}
   */
  const directional = (source, candidates) => {
    /** @type {number[]} */
    const scores = [];
    for (const prototype of source) {
      const matches = candidates
        .map((candidate) => milestoneSequenceSimilarity(prototype, candidate))
        .sort((a, b) => b - a)
        .slice(0, Math.min(3, candidates.length));
      if (matches.length > 0) scores.push(mean(matches));
    }
    return scores.length > 0 ? mean(scores) : 0;
  };
  return clamp01((directional(left, right) + directional(right, left)) / 2);
}

/**
 * @param {MilestoneSet} left
 * @param {MilestoneSet} right
 * @returns {number}
 */
function milestoneSequenceSimilarity(left, right) {
  if (!left.length || !right.length) return 0;
  const used = new Set();
  let matched = 0;
  for (const a of left) {
    let bestIndex = -1;
    let best = 0;
    for (let index = 0; index < right.length; index += 1) {
      if (used.has(index) || right[index].key !== a.key) continue;
      const delta = Math.abs(a.atSec - right[index].atSec);
      const similarity = Math.exp(-0.5 * Math.pow(delta / 35, 2));
      if (similarity > best) {
        best = similarity;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matched += milestoneWeight(a.key) * best;
    }
  }
  const leftWeight = left.reduce((sum, row) => sum + milestoneWeight(row.key), 0);
  const rightWeight = right.reduce((sum, row) => sum + milestoneWeight(row.key), 0);
  return clamp01((2 * matched) / Math.max(1e-9, leftWeight + rightWeight));
}

/**
 * @param {MilestoneSet[]} targetSets
 * @param {MilestoneSet[]} candidateSets
 * @param {number} limit
 * @returns {Array<{name: string, deltaSec: number}>}
 */
function milestoneHighlights(targetSets, candidateSets, limit) {
  // Compare stable mean timings per milestone instead of searching every
  // replay-pair combination. Besides being much cheaper, this avoids calling
  // one coincidental pair a highlight when the player's usual timing differs.
  /**
   * @param {MilestoneSet[]} sets
   * @returns {Map<string, {name: string, totalSec: number, count: number}>}
   */
  const summarize = (sets) => {
    /** @type {Map<string, {name: string, totalSec: number, count: number}>} */
    const byKey = new Map();
    for (const rows of sets) {
      for (const row of rows) {
        const prior = byKey.get(row.key) || {
          name: row.name,
          totalSec: 0,
          count: 0,
        };
        prior.totalSec += row.atSec;
        prior.count += 1;
        byKey.set(row.key, prior);
      }
    }
    return byKey;
  };
  const target = summarize(targetSets);
  const candidate = summarize(candidateSets);
  /** @type {Array<{name: string, deltaSec: number}>} */
  const shared = [];
  for (const [key, left] of target) {
    const right = candidate.get(key);
    if (!right) continue;
    shared.push({
      name: left.name,
      deltaSec: Math.round(Math.abs(
        left.totalSec / left.count - right.totalSec / right.count,
      )),
    });
  }
  return shared
    .sort((a, b) => a.deltaSec - b.deltaSec || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @returns {number|null}
 */
function distributionOverlap(left, right) {
  const a = frequencyMap(left);
  const b = frequencyMap(right);
  if (a.total === 0 || b.total === 0) return null;
  const keys = new Set([...a.counts.keys(), ...b.counts.keys()]);
  let overlap = 0;
  for (const key of keys) {
    overlap += Math.min(
      (a.counts.get(key) || 0) / a.total,
      (b.counts.get(key) || 0) / b.total,
    );
  }
  return clamp01(overlap);
}

/**
 * @param {unknown[]} values
 * @returns {{counts: Map<string, number>, total: number}}
 */
function frequencyMap(values) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let total = 0;
  for (const value of values) {
    const label = validBehaviorLabel(value);
    if (!label) continue;
    const key = label.toLocaleLowerCase("en-US");
    counts.set(key, (counts.get(key) || 0) + 1);
    total += 1;
  }
  return { counts, total };
}

/**
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @param {number} limit
 * @returns {string[]}
 */
function sharedLabels(left, right, limit) {
  /** @type {Map<string, string>} */
  const a = new Map();
  for (const raw of left) {
    const label = validBehaviorLabel(raw);
    if (label) a.set(label.toLocaleLowerCase("en-US"), label);
  }
  const b = new Set(
    right
      .map(validBehaviorLabel)
      .filter((label) => label !== null)
      .map((label) => label.toLocaleLowerCase("en-US")),
  );
  return [...a.entries()]
    .filter(([key]) => b.has(key))
    .map(([, label]) => label)
    .sort((x, y) => x.localeCompare(y))
    .slice(0, limit);
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number|null}
 */
function jsSimilarity(left, right) {
  const sumLeft = left.reduce((sum, value) => sum + Math.max(0, value), 0);
  const sumRight = right.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (sumLeft <= 0 || sumRight <= 0) return null;
  let divergence = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const p = Math.max(0, left[index] || 0) / sumLeft;
    const q = Math.max(0, right[index] || 0) / sumRight;
    const m = (p + q) / 2;
    if (p > 0) divergence += 0.5 * p * Math.log(p / m);
    if (q > 0) divergence += 0.5 * q * Math.log(q / m);
  }
  return clamp01(1 - divergence / Math.log(2));
}

/**
 * @param {number[]} left
 * @param {number[]} right
 * @returns {number|null}
 */
function cosineSimilarity(left, right) {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = Math.max(0, finiteOr(left[index], 0));
    const b = Math.max(0, finiteOr(right[index], 0));
    dot += a * b;
    normLeft += a * a;
    normRight += b * b;
  }
  if (normLeft <= 0 || normRight <= 0) return null;
  return clamp01(dot / Math.sqrt(normLeft * normRight));
}

/**
 * @param {Set<number>} left
 * @param {Set<number>} right
 * @returns {number|null}
 */
function jaccardSimilarity(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set)) return null;
  const union = new Set([...left, ...right]);
  if (union.size === 0) return null;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

/**
 * @param {number} left
 * @param {number} right
 * @returns {number|null}
 */
function ratioSimilarity(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.exp(-Math.abs(Math.log((left + 0.05) / (right + 0.05))));
}

/**
 * @param {LooseRecord[]} candidates
 * @param {EvidenceSummary} targetEvidence
 * @returns {{unknownLikelihood: number}}
 */
function attachOpenSetLikelihoods(candidates, targetEvidence) {
  const targetCoverage =
    (targetEvidence.buildGames > 0 ? COMPONENT_WEIGHTS.buildOrders : 0)
    + (targetEvidence.controlGroupGames > 0 ? COMPONENT_WEIGHTS.controlGroups : 0);
  const targetReliability = (
    COMPONENT_WEIGHTS.buildOrders
      * Math.sqrt(Math.min(targetEvidence.buildGames, 5) / 5)
    + COMPONENT_WEIGHTS.controlGroups
      * Math.sqrt(Math.min(targetEvidence.controlGroupGames, 5) / 5)
  ) * (0.55 + 0.45 * targetCoverage);
  const unknownLogit = 1.1 + 1.4 * (1 - clamp01(targetReliability));
  const logits = candidates.map(
    (candidate) => 12 * (finiteOr(candidate.rankScore, 0.5) - 0.5),
  );
  logits.push(unknownLogit);
  const max = Math.max(...logits);
  const weights = logits.map((value) => Math.exp(value - max));
  const denominator = weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < candidates.length; index += 1) {
    candidates[index].likelihood = round4(weights[index] / denominator);
  }
  return {
    unknownLikelihood: round4(weights[weights.length - 1] / denominator),
  };
}

/**
 * @param {ComponentSample[]} componentSamples
 * @param {number} coverage
 * @returns {number}
 */
function evidenceReliability(componentSamples, coverage) {
  let sampleQuality = 0;
  for (const row of componentSamples) {
    const target = Math.min(Math.max(0, row.target), 5) / 5;
    const candidate = Math.min(Math.max(0, row.candidate), 8) / 8;
    sampleQuality += row.weight * Math.sqrt(target * candidate);
  }
  return clamp01(sampleQuality * (0.55 + 0.45 * coverage));
}

/**
 * @param {{
 *   targetSamples: number,
 *   candidateSamples: number,
 *   coverage: number,
 *   patternMatch: number,
 *   componentSamples: ComponentSample[],
 * }} input
 * @returns {'low'|'medium'|'high'}
 */
function confidenceBand({
  targetSamples,
  candidateSamples,
  coverage,
  patternMatch,
  componentSamples,
}) {
  const everyComponentDeep = componentSamples.every(
    (row) => row.target >= 4 && row.candidate >= 5,
  );
  if (
    everyComponentDeep
    && coverage >= 0.99
    && patternMatch >= 0.72
  ) return "high";
  const reliability = evidenceReliability(componentSamples, coverage);
  if (
    targetSamples >= 2
    && candidateSamples >= 3
    && reliability >= 0.28
  ) {
    return "medium";
  }
  return "low";
}

/**
 * @param {LooseRecord|null} buildOrders
 * @param {LooseRecord|null} controlGroups
 * @param {number} targetSamples
 * @returns {string[]}
 */
function candidateCaveats(buildOrders, controlGroups, targetSamples) {
  /** @type {string[]} */
  const caveats = [];
  if (!controlGroups) {
    caveats.push("build_only_reprocess_for_control_groups");
  }
  if (!buildOrders) caveats.push("control_groups_only_no_build_match");
  if (targetSamples <= 1) caveats.push("single_target_replay");
  return caveats;
}

/**
 * @param {LooseRecord} a
 * @param {LooseRecord} b
 * @returns {number}
 */
function candidateSort(a, b) {
  return finiteOr(b.rankScore, 0) - finiteOr(a.rankScore, 0)
    || finiteOr(b.patternMatch, 0) - finiteOr(a.patternMatch, 0)
    || String(a.name || "").localeCompare(String(b.name || ""));
}

/**
 * @param {LooseRecord} doc
 * @returns {LooseRecord[]}
 */
function opponentIdentityClauses(doc) {
  /** @type {LooseRecord[]} */
  const clauses = [];
  const pulseId = cleanString(doc?.pulseId);
  const characterId = cleanString(doc?.pulseCharacterId);
  if (pulseId) clauses.push({ "opponent.pulseId": pulseId });
  if (characterId) clauses.push({ "opponent.pulseCharacterId": characterId });
  return clauses;
}

/**
 * @param {unknown} value
 * @returns {RaceCode|null}
 */
function canonicalRace(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  const first = raw[0].toUpperCase();
  return first === "P" || first === "T" || first === "Z" ? first : null;
}

/**
 * @param {RaceCode} race
 * @returns {string[]}
 */
function raceVariants(race) {
  const name = RACE_NAMES[race];
  if (!name) return [];
  return [race, race.toLowerCase(), name, name.toUpperCase(), name.toLowerCase()];
}

/**
 * @param {CharacterLink|null|undefined} link
 * @returns {string|null}
 */
function linkGroupKey(link) {
  if (!link || typeof link !== "object") return null;
  const proId = cleanString(link.proId);
  if (proId) return `pro:${proId}`;
  const accountId = cleanString(link.accountId);
  return accountId ? `acct:${accountId}` : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function readableName(value) {
  const clean = cleanString(value);
  return clean && !isBarcodeLikeName(clean) ? clean : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBarcodeLikeName(value) {
  const clean = cleanString(value);
  return Boolean(clean && /^[Il1i|ⅠΙＩｌｉ１｜]+$/u.test(clean));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalBuildToken(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  const withoutAction = raw.replace(
    /^(?:Build|Train|Morph|Research)(?=[A-Z])/,
    "",
  );
  return withoutAction.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

/**
 * @param {string} key
 * @returns {number}
 */
function milestoneWeight(key) {
  if (/(pylon|supplydepot|overlord)$/.test(key)) return 0.65;
  if (
    /(core|lair|hive|spire|factory|starport|robotics|twilight|forge|armory|academy|bay|pit|den|shrine|archives|fleetbeacon|fusioncore|nexus|commandcenter|hatchery)/.test(key)
  ) return 1.35;
  return 1;
}

/**
 * @param {number[]} vector
 * @param {number} limit
 * @returns {number[]}
 */
function topVectorIndices(vector, limit) {
  return vector
    .map((value, index) => ({ value, index }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.index);
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function validMmr(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 && number <= 9999
    ? Math.round(number)
    : null;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function boundedCount(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.max(0, Math.min(99999, Math.round(number)));
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function integerInRange(value, min, max) {
  const number = finiteNumber(value);
  if (number === null || !Number.isInteger(number) || number < min || number > max) {
    return null;
  }
  return number;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function validBehaviorLabel(value) {
  const label = cleanString(value);
  if (!label) return null;
  if (/game too short/i.test(label)) return null;
  if (/unclassified/i.test(label)) return null;
  if (/^(?:unknown|unsorted|n\/?a|none)$/i.test(label)) return null;
  return label.replace(/\s+/g, " ");
}

/**
 * @param {Date|string|number|null|undefined} value
 * @returns {number}
 */
function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clampResultLimit(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_RESULT_LIMIT), 10);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_RESULT_LIMIT, parsed))
    : DEFAULT_RESULT_LIMIT;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, finiteOr(value, 0)));
}

/**
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

module.exports = {
  OpponentIdentityMatcherService,
  identityEligibility,
  isBarcodeLikeName,
  scoreCandidate,
  milestoneSequenceSimilarity,
  jsSimilarity,
};
