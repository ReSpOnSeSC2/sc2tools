"use strict";

/**
 * Coaching Locker persistence + directory service.
 *
 * One document holds the whole Locker state (the same JSON shape the
 * standalone Locker keeps in-page; the Locker's "Export backup" file is
 * a valid seed). Writes are compare-and-set on ``rev`` so two coaches
 * editing at once conflict instead of clobbering.
 *
 * Roles are resolved from the state document itself:
 *   admin   — platform admin (``isAdmin`` gate) or the first coach
 *   coach   — any entry in ``state.coaches[]`` linked to this userId
 *   student — any entry in ``state.students[]`` linked to this userId
 */

const { COLLECTIONS } = require("../config/constants");
const { stampVersion } = require("../db/schemaVersioning");
const { gamesMatchStage } = require("../util/parseQuery");
const { randomUUID } = require("node:crypto");

const DOC_ID = "locker";
const CALENDAR_PREFIX = "calendar:";
const ASSIGNMENT_PREFIX = "assignment:";
const ASSIGNMENT_KIND = "game_requirement";
const PRIMARY_COACH_ID = "c1";
const PRIMARY_COACH_BOOTSTRAP_ATTEMPTS = 5;
const USERS_PAGE = 20;
const GAMES_CAP = 500;
const SLOT_STEP_MINUTES = 30;
const MIN_DURATION_MINUTES = 30;
const MAX_DURATION_MINUTES = 8 * 60;
const SLOT_HORIZON_DAYS = 42;
const MAX_WINDOWS_PER_DAY = 6;
const MAX_BOOKINGS_RETURNED = 120;
const ROSTER_LOCK_MS = 5 * 60 * 1000;
const ASSIGNMENT_LIST_CAP = 100;
const ASSIGNMENT_LIST_DEFAULT = 20;
const ASSIGNMENT_GAME_LIST_CAP = 500;
const ASSIGNMENT_MAX_DAYS = 366;
const ASSIGNMENT_MAX_REQUIRED_GAMES = 1000;
const ASSIGNMENT_RECURRENCES = new Set(["once", "daily", "weekly", "monthly"]);
const PRACTICE_SHARING_POLICY_VERSION = "practice-replays-v1";
const COACHING_MUTATION_LEASE_MS = 15 * 60 * 1000;
/** @type {Map<string, Intl.DateTimeFormat>} */
const ZONE_PART_FORMATTERS = new Map();

class CoachingService {
  /**
   * @param {{db: {
   *   coaching: import('mongodb').Collection,
   *   users: import('mongodb').Collection,
   *   games: import('mongodb').Collection,
   *   devicePairings: import('mongodb').Collection,
   *   deviceTokens: import('mongodb').Collection,
   * }, io?: import('socket.io').Server|null, logger?: import('pino').Logger,
   * now?: () => Date}} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.io = deps.io || null;
    this.logger = deps.logger || null;
    this.assignmentClock = typeof deps.now === "function" ? deps.now : () => new Date();
  }

  _assignmentNow() {
    const value = this.assignmentClock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  /**
   * Register a live mutation on every account whose shared coaching data the
   * write can touch. The users-row update and GDPR's `_gdprMutation` claim
   * contend on the same Mongo document: whichever wins excludes the other.
   * A lease makes a process crash self-healing; normal paths remove the token
   * immediately. GDPR performs its coaching cleanup only after this guard can
   * no longer be acquired.
   *
   * @template T
   * @param {Array<string|undefined|null>} userIds
   * @param {() => Promise<T>} mutate
   * @returns {Promise<T>}
   */
  async _withCoachingMutation(userIds, mutate) {
    const ids = Array.from(new Set(userIds.map(safeIdentity).filter(Boolean))).sort();
    if (ids.length === 0) return mutate();
    if (!this.db.users || typeof this.db.users.updateMany !== "function") {
      throw new Error("coaching_mutation_guard_unavailable");
    }

    const mutationId = randomUUID();
    const now = new Date();
    const mutation = {
      id: mutationId,
      leaseUntil: new Date(now.getTime() + COACHING_MUTATION_LEASE_MS),
    };
    const acquired = await this.db.users.updateMany(
      {
        userId: { $in: ids },
        $or: [
          { _gdprMutation: { $exists: false } },
          { "_gdprMutation.leaseUntil": { $lte: now } },
          { "_gdprMutation.leaseUntil": { $exists: false } },
        ],
      },
      [{
        $set: {
          // Claiming an expired/crash-residue GDPR fence and removing it in
          // this same user-row write prevents its old owner from renewing by
          // id after the coaching token becomes visible.
          _gdprMutation: "$$REMOVE",
          _coachingMutations: {
            $concatArrays: [
              {
                $filter: {
                  input: {
                    $cond: [
                      { $isArray: "$_coachingMutations" },
                      "$_coachingMutations",
                      [],
                    ],
                  },
                  as: "mutation",
                  cond: { $gt: ["$$mutation.leaseUntil", now] },
                },
              },
              [mutation],
            ],
          },
        },
      }],
    );
    if (acquired.matchedCount !== ids.length) {
      await this._releaseCoachingMutation(ids, mutationId);
      throw coachingError(
        409,
        "account_deletion_in_progress",
        "A coaching account is being deleted. Reload and try again.",
      );
    }

    try {
      return await mutate();
    } finally {
      await this._releaseCoachingMutation(ids, mutationId);
    }
  }

  /** @param {string[]} userIds @param {string} mutationId */
  async _releaseCoachingMutation(userIds, mutationId) {
    try {
      await this.db.users.updateMany(
        { userId: { $in: userIds }, "_coachingMutations.id": mutationId },
        /** @type {any} */ ({ $pull: { _coachingMutations: { id: mutationId } } }),
      );
    } catch (err) {
      // The finite lease still prevents a permanent block after a transient
      // release failure; do not turn an already-committed coaching write into
      // a misleading client failure and duplicate retry.
      if (this.logger) {
        this.logger.warn({ err, mutationId }, "coaching_mutation_guard_release_failed");
      }
    }
  }

  /** @returns {Promise<{state: Record<string, any>, rev: number}>} */
  async getDoc() {
    const doc = await this.db.coaching.findOne(/** @type {any} */ ({ _id: DOC_ID }));
    if (!doc) return { state: emptyState(), rev: 0 };
    return { state: doc.state || emptyState(), rev: doc.rev || 0 };
  }

  /**
   * Lightweight identity projection for role checks and scheduling. Locker
   * assets can approach the document budget; header alert probes must never
   * pull those blobs just to compare a userId.
   * @returns {Promise<{coaches:any[],students:any[],rev:number}>}
   */
  async getRoster() {
    const doc = await this.db.coaching.findOne(
      /** @type {any} */ ({ _id: DOC_ID }),
      {
        projection: {
          _id: 0,
          rev: 1,
          "state.coaches": 1,
          "state.students.id": 1,
          "state.students.name": 1,
          "state.students.userId": 1,
          "state.students.coachId": 1,
          "state.students.practiceSharing": 1,
        },
      },
    );
    const state = doc && doc.state ? doc.state : {};
    return {
      coaches: Array.isArray(state.coaches) ? state.coaches : [],
      students: Array.isArray(state.students) ? state.students : [],
      rev: doc && doc.rev ? doc.rev : 0,
    };
  }

  /**
   * Compare-and-set write of the full state document.
   *
   * @param {Record<string, any>} state
   * @param {number} expectedRev
   * @param {Array<string|undefined|null>} [protectedUserIds]
   * @returns {Promise<{ok: true, rev: number}|{ok: false, rev: number, state: Record<string, any>}>}
   */
  async putState(state, expectedRev, protectedUserIds = []) {
    return this._withCoachingMutation(protectedUserIds, async () => {
      const next = (expectedRev || 0) + 1;
      const update = stampVersion(
        { state, rev: next, updatedAt: new Date() },
        COLLECTIONS.COACHING,
      );
      const res = await this.db.coaching.updateOne(
        /** @type {any} */ (expectedRev
          ? { _id: DOC_ID, rev: expectedRev }
          : { _id: DOC_ID, rev: { $in: [0, null] } }),
        {
          $set: update,
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: expectedRev === 0 },
      );
      if (res.matchedCount === 0 && res.upsertedCount === 0) {
        const cur = await this.getDoc();
        return { ok: false, rev: cur.rev, state: cur.state };
      }
      return { ok: true, rev: next };
    });
  }

  /**
   * Fence calendars before a roster removal/reassignment. The lock and
   * rosterRev increment happen atomically on each affected calendar:
   * in-flight bookings either win first (and block the roster edit) or see a
   * lock/revision mismatch and fail. This closes the cross-document race
   * without requiring every deployment to support Mongo transactions.
   * @param {Record<string, any>} state
   * @param {number} expectedRev
   * @param {Array<string|undefined|null>} [protectedUserIds]
   */
  async putStateWithRosterGuard(state, expectedRev, protectedUserIds = []) {
    return this._withCoachingMutation(protectedUserIds, async () => {
    const current = await this.getDoc();
    if (current.rev !== expectedRev) {
      return { ok: false, rev: current.rev, state: current.state };
    }
    // Practice/replay consent is server-owned. Whole-state Locker writes may
    // edit the rest of a student record, but they cannot grant consent on the
    // student's behalf. A changed account relationship always starts pending.
    const guardedState = guardPracticeSharingState(
      current.state,
      state,
      this._assignmentNow(),
    );
    const relationshipUserIds = changedCoachingAccountIds(
      current.state,
      guardedState,
    );
    return this._withCoachingMutation(relationshipUserIds, async () => {
    const changes = changedRosterStudents(current.state, guardedState);
    if (changes.size === 0) return this.putState(guardedState, expectedRev);

    const token = randomUUID();
    const at = new Date();
    const expiresAt = new Date(at.getTime() + ROSTER_LOCK_MS);
    /** @type {string[]} */
    const acquired = [];
    try {
      for (const [coachId, studentIds] of changes) {
        let result = null;
        try {
          result = await this.db.coaching.updateOne(
            /** @type {any} */ ({
              _id: calendarId(coachId),
              $and: [
                { $or: [
                  { rosterLock: { $exists: false } },
                  { rosterLockExpiresAt: { $lte: at } },
                ] },
                { $nor: [{
                  bookings: { $elemMatch: {
                    studentId: { $in: Array.from(studentIds) },
                    status: "booked",
                    endAt: { $gt: at },
                  } },
                }] },
              ],
            }),
            {
              $set: { rosterLock: token, rosterLockExpiresAt: expiresAt },
              $setOnInsert: {
                createdAt: at,
                bookings: [],
                availabilityRev: 0,
                calendarRev: 0,
              },
              $inc: { rosterRev: 1 },
            },
            { upsert: true },
          );
        } catch (error) {
          if (!error || /** @type {any} */ (error).code !== 11000) throw error;
        }
        if (!result || (result.matchedCount !== 1 && result.upsertedCount !== 1)) {
          throw coachingError(409, "active_bookings", "Cancel the student's active coaching sessions before removing or reassigning them.");
        }
        acquired.push(coachId);
      }
      return await this.putState(guardedState, expectedRev);
    } finally {
      const releases = await Promise.allSettled(acquired.map((coachId) =>
        this.db.coaching.updateOne(
          /** @type {any} */ ({ _id: calendarId(coachId), rosterLock: token }),
          { $unset: { rosterLock: "", rosterLockExpiresAt: "" } },
        ),
      ));
      if (this.logger && releases.some((release) => release.status === "rejected")) {
        this.logger.error({ token }, "coaching_roster_lock_release_failed");
      }
    }
    });
    });
  }

  /**
   * Resolve the caller's coaching role from the state document.
   *
   * @param {string} userId  internal user UUID (req.auth.userId)
   * @param {boolean} platformAdmin
   * @returns {Promise<{role: 'admin'|'coach'|'student'|'none',
   *   coachId?: string, studentId?: string, rev: number}>}
   */
  async roleFor(userId, platformAdmin) {
    let roster = await this.getRoster();
    // The first site-backed Locker can predate multi-coach account linking.
    // A platform admin was still allowed into that Locker, but there was no
    // durable coach row for scheduling to attach a calendar (or booking
    // notifications) to. Claim that empty roster once, using the same `c1`
    // identity as the legacy Locker client. The CAS write makes simultaneous
    // first requests converge on one real coach instead of creating a
    // request-local/synthetic actor.
    if (platformAdmin && roster.coaches.length === 0) {
      roster = await this._bootstrapPrimaryCoach(userId);
    }
    const { coaches, students, rev } = roster;
    const coach = coaches.find((c) => c && c.userId === userId);
    const adminCoach = coaches.length > 0 ? coaches[0] : null;
    if (platformAdmin || (adminCoach && adminCoach.userId === userId)) {
      return {
        role: "admin",
        coachId: coach ? coach.id : adminCoach ? adminCoach.id : undefined,
        rev,
      };
    }
    if (coach) return { role: "coach", coachId: coach.id, rev };
    const student = students.find((s) => s && s.userId === userId);
    if (student) return { role: "student", studentId: student.id, rev };
    return { role: "none", rev };
  }

  /**
   * Persist the platform admin as the primary coach for an unclaimed Locker.
   * Existing coach rosters are never changed. Students from the legacy
   * single-coach shape receive the client-compatible `c1` assignment only
   * when they do not already carry an explicit coachId.
   *
   * @param {string} userId
   * @returns {Promise<{coaches:any[],students:any[],rev:number}>}
   */
  async _bootstrapPrimaryCoach(userId) {
    let current = await this.getDoc();
    for (let attempt = 0; attempt < PRIMARY_COACH_BOOTSTRAP_ATTEMPTS; attempt += 1) {
      const currentCoaches = Array.isArray(current.state.coaches)
        ? current.state.coaches
        : [];
      if (currentCoaches.length > 0) {
        return rosterFromState(current.state, current.rev);
      }

      const students = Array.isArray(current.state.students)
        ? current.state.students.map((student) => (
          student && !student.coachId
            ? { ...student, coachId: PRIMARY_COACH_ID }
            : student
        ))
        : [];
      const storedName = typeof current.state.coach === "string"
        ? current.state.coach.trim()
        : "";
      const coach = {
        id: PRIMARY_COACH_ID,
        name: storedName || "Coach",
        userId,
      };
      const nextState = {
        ...current.state,
        coaches: [coach],
        students,
      };
      try {
        const result = await this.putState(nextState, current.rev, [userId]);
        if (result.ok) {
          return rosterFromState(nextState, result.rev);
        }
        current = { state: result.state, rev: result.rev };
      } catch (error) {
        // Two initial requests can both observe a missing document and race
        // the upsert. The unique _id winner is authoritative; reread it.
        if (!error || /** @type {any} */ (error).code !== 11000) throw error;
        current = await this.getDoc();
      }
    }

    const latest = await this.getRoster();
    if (latest.coaches.length > 0) return latest;
    throw coachingError(
      409,
      "coaching_setup_conflict",
      "Coaching setup changed while it was being initialized. Reload and try again.",
    );
  }

  /**
   * Signed-up user directory for the link pickers. Searches the cached
   * email (webhook/first-touch populated) case-insensitively; each row
   * carries a REAL agent check — whether the account has a live device
   * pairing — plus its last-seen time.
   *
   * @param {string} q
   * @returns {Promise<Array<{userId: string, clerkUserId: string|null,
   *   email: string, hasAgent: boolean, agentLastSeen: string|null}>>}
   */
  async listUsers(q) {
    /** @type {Record<string, any>} */
    const filter = { email: { $type: "string", $ne: "" } };
    if (typeof q === "string" && q.trim().length > 0) {
      filter.email = { $regex: escapeRegex(q.trim()), $options: "i" };
    }
    const rows = await this.db.users
      .find(filter, {
        projection: { _id: 0, userId: 1, clerkUserId: 1, email: 1 },
      })
      .sort({ email: 1 })
      // Read past the visible page because historical duplicate account rows
      // can share an email. We collapse those below and prefer the row with
      // an active agent token so the picker links the working account.
      .limit(USERS_PAGE * 3)
      .toArray();
    const ids = rows.map((r) => r.userId).filter(Boolean);
    /** @type {Map<string, Date|null>} */
    const agentSeen = new Map();
    if (ids.length > 0) {
      // A consumed pairing row is only the short-lived code exchange. The
      // durable source of truth for an installed/paired agent is its active
      // device token (the same collection used by /v1/me and Admin users).
      const pairings = await this.db.deviceTokens
        .find(
          { userId: { $in: ids }, revokedAt: null },
          { projection: { _id: 0, userId: 1, lastSeenAt: 1 } },
        )
        .toArray();
      for (const p of pairings) {
        const prev = agentSeen.get(p.userId);
        const seen = p.lastSeenAt instanceof Date ? p.lastSeenAt : null;
        if (!prev || (seen && (!(prev instanceof Date) || seen > prev))) {
          agentSeen.set(p.userId, seen);
        }
      }
    }
    const candidates = rows.map((r) => ({
      userId: r.userId,
      clerkUserId: r.clerkUserId || null,
      email: r.email,
      hasAgent: agentSeen.has(r.userId),
      agentLastSeen: (() => {
        const d = agentSeen.get(r.userId);
        return d instanceof Date ? d.toISOString() : null;
      })(),
    }));
    /** @type {Map<string, (typeof candidates)[number]>} */
    const unique = new Map();
    for (const candidate of candidates) {
      const key = candidate.email.trim().toLowerCase();
      const existing = unique.get(key);
      if (!existing || (!existing.hasAgent && candidate.hasAgent)) {
        unique.set(key, candidate);
      }
    }
    return Array.from(unique.values()).slice(0, USERS_PAGE);
  }

  /**
   * Slim per-user game list for the pickers and the season lanes (the
   * client computes lanes with the shared season catalog).
   *
   * @param {string} userId
   * @returns {Promise<Array<{d: string, m: string, o: string,
   *   res: string, b: string, bid: string}>>}
   */
  async gamesFor(userId) {
    const rows = await this.db.games
      .find(
        {
          userId,
          isResumedFromReplay: { $ne: true },
          ...oneVsOneGameClause(),
        },
        {
          projection: {
            _id: 0, date: 1, map: 1, opponent: 1, result: 1, myBuild: 1,
            _customBuildSlug: 1,
          },
        },
      )
      .sort({ date: -1 })
      .limit(GAMES_CAP)
      .toArray();
    return rows
      .map((g) => ({
        d: toDay(g.date),
        m: typeof g.map === "string" ? g.map : "",
        o: typeof g.opponent === "string" ? g.opponent : "",
        res: g.result === "Win" ? "W" : g.result === "Loss" ? "L" : "",
        b: typeof g.myBuild === "string" ? g.myBuild : "",
        bid: typeof g._customBuildSlug === "string" ? g._customBuildSlug : "",
      }))
      .filter((g) => g.d);
  }

  /**
   * Privacy-minimal ranked-record summary for the Coaching performance view.
   * The route supplies a server-resolved student userId and forces ranked 1v1
   * through the shared filter builder. One slim-row scan produces both the
   * overall W/L headline and the exact own-race/opponent-race matrix; no replay
   * assets, opponent identities, or heavy game-details are read.
   *
   * @param {string} userId
   * @param {Record<string, any>} filters
   * @returns {Promise<{
   *   summary:{games:number,wins:number,losses:number,winRate:number,
   *     classifiedGames:number,unclassifiedGames:number},
   *   matchups:Array<{
   *     matchup:string,myRace:string,opponentRace:string,
   *     games:number,wins:number,losses:number,winRate:number
   *   }>
   * }>}
   */
  async performanceRecord(userId, filters) {
    const match = gamesMatchStage(userId, filters || {});
    const [root = {}] = await this.db.games
      .aggregate([
        { $match: match },
        {
          $addFields: {
            _coachingResult: coachingResultExpr(),
            _coachingMyRace: coachingRaceExpr("$myRace"),
            _coachingOpponentRace: coachingRaceExpr("$opponent.race"),
          },
        },
        {
          $facet: {
            summary: [
              { $match: { _coachingResult: { $in: ["win", "loss"] } } },
              {
                $group: {
                  _id: null,
                  games: { $sum: 1 },
                  wins: {
                    $sum: {
                      $cond: [{ $eq: ["$_coachingResult", "win"] }, 1, 0],
                    },
                  },
                  losses: {
                    $sum: {
                      $cond: [{ $eq: ["$_coachingResult", "loss"] }, 1, 0],
                    },
                  },
                },
              },
              { $project: { _id: 0, games: 1, wins: 1, losses: 1 } },
            ],
            matchups: [
              {
                $match: {
                  _coachingResult: { $in: ["win", "loss"] },
                  _coachingMyRace: { $in: ["P", "T", "Z"] },
                  _coachingOpponentRace: { $in: ["P", "T", "Z"] },
                },
              },
              {
                $group: {
                  _id: {
                    myRace: "$_coachingMyRace",
                    opponentRace: "$_coachingOpponentRace",
                  },
                  games: { $sum: 1 },
                  wins: {
                    $sum: {
                      $cond: [{ $eq: ["$_coachingResult", "win"] }, 1, 0],
                    },
                  },
                  losses: {
                    $sum: {
                      $cond: [{ $eq: ["$_coachingResult", "loss"] }, 1, 0],
                    },
                  },
                },
              },
              { $sort: { "_id.myRace": 1, "_id.opponentRace": 1 } },
            ],
          },
        },
      ])
      .toArray();
    const totals = Array.isArray(root.summary) ? root.summary[0] : null;
    const games = nonNegativeInteger(totals && totals.games);
    const wins = nonNegativeInteger(totals && totals.wins);
    const losses = nonNegativeInteger(totals && totals.losses);
    const matchupRows = (Array.isArray(root.matchups) ? root.matchups : [])
      .map((row) => {
        const myRace = coachingRaceLetter(row && row._id && row._id.myRace);
        const opponentRace = coachingRaceLetter(
          row && row._id && row._id.opponentRace,
        );
        const rowGames = nonNegativeInteger(row && row.games);
        const rowWins = nonNegativeInteger(row && row.wins);
        const rowLosses = nonNegativeInteger(row && row.losses);
        return {
          matchup: `${myRace}v${opponentRace}`,
          myRace,
          opponentRace,
          games: rowGames,
          wins: rowWins,
          losses: rowLosses,
          winRate: rowGames > 0 ? rowWins / rowGames : 0,
        };
      })
      .filter((row) => row.myRace !== "U" && row.opponentRace !== "U")
      .sort((a, b) => coachingMatchupOrder(a.matchup) - coachingMatchupOrder(b.matchup));
    const classifiedGames = Math.min(
      games,
      matchupRows.reduce((total, row) => total + row.games, 0),
    );
    return {
      summary: {
        games,
        wins,
        losses,
        winRate: games > 0 ? wins / games : 0,
        classifiedGames,
        unclassifiedGames: games - classifiedGames,
      },
      matchups: matchupRows,
    };
  }

  /**
   * Return the live, account-bound practice/replay sharing relationship(s)
   * visible to the caller. Missing legacy consent is deliberately reported as
   * pending; it is never treated as an implicit opt-in.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   */
  async practiceSharingFor(userId, coachingRole) {
    const context = await this._assignmentContext(userId, coachingRole);
    const relationships = context.roster.students
      .map((/** @type {any} */ student) => {
        const coach = context.roster.coaches.find((/** @type {any} */ item) =>
          item && student && item.id === student.coachId,
        );
        if (!student || !coach) return null;
        if (context.kind === "coach" && coach.id !== context.coach.id) return null;
        if (context.kind === "student" && student.id !== context.student.id) return null;
        return publicPracticeSharing(student, coach);
      })
      .filter(Boolean);
    return { rev: context.roster.rev, relationships };
  }

  /**
   * A coach may request (or re-request after rejection/revocation) access, but
   * only the linked student account can accept it.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} studentId
   * @param {Record<string, unknown>} input
   */
  async requestPracticeSharing(userId, coachingRole, studentId, input) {
    const expectedRev = practiceSharingRevision(input && input.expectedRev);
    const current = await this.getDoc();
    if (current.rev !== expectedRev) throw practiceSharingConflict(current.rev);
    const roster = rosterFromState(current.state, current.rev);
    const context = assignmentContextFromRoster(userId, coachingRole, roster);
    if (!context || context.kind === "student") {
      throw coachingError(404, "not_found", "Not found.");
    }
    const student = roster.students.find((item) => item
      && item.id === safeIdentity(studentId)
      && (context.kind === "admin" || item.coachId === context.coach.id));
    const coach = student && roster.coaches.find((item) =>
      item && item.id === student.coachId,
    );
    if (!student || !coach || !safeIdentity(student.userId) || !safeIdentity(coach.userId)) {
      throw coachingError(404, "student_not_found", "The linked coaching student was not found.");
    }
    const sharing = practiceSharingSnapshot(student, coach);
    const storedSharing = student.practiceSharing;
    const exactStoredRequest = storedSharing
      && storedSharing.studentUserId === student.userId
      && storedSharing.coachUserId === coach.userId
      && storedSharing.policyVersion === PRACTICE_SHARING_POLICY_VERSION
      && storedSharing.status === "pending";
    if (sharing.status === "accepted" || exactStoredRequest) {
      return { rev: current.rev, relationship: publicPracticeSharing(student, coach) };
    }
    const now = this._assignmentNow();
    const practiceSharing = {
      version: 1,
      policyVersion: PRACTICE_SHARING_POLICY_VERSION,
      status: "pending",
      studentUserId: student.userId,
      coachUserId: coach.userId,
      requestedAt: now,
      respondedAt: null,
      revokedAt: null,
      grantId: null,
    };
    const state = replaceStudentPracticeSharing(current.state, student.id, practiceSharing);
    const result = await this.putState(
      state,
      current.rev,
      [userId, student.userId, coach.userId],
    );
    if (!result.ok) throw practiceSharingConflict(result.rev);
    this._notifyAssignment(student.userId, {
      kind: "practice_sharing_requested",
      coachName: safeAssignmentName(coach.name, "Coach"),
    });
    return {
      rev: result.rev,
      relationship: publicPracticeSharing({ ...student, practiceSharing }, coach),
    };
  }

  /**
   * Accept or reject the student's current pending relationship. The coach id
   * is echoed by the client as a stale-screen guard; account ids are resolved
   * exclusively from the live roster.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {Record<string, unknown>} input
   */
  async respondPracticeSharing(userId, coachingRole, input) {
    const expectedRev = practiceSharingRevision(input && input.expectedRev);
    const decision = input && input.decision;
    if (decision !== "accepted" && decision !== "rejected") {
      throw coachingError(400, "invalid_practice_sharing_decision", "decision must be accepted or rejected.");
    }
    const current = await this.getDoc();
    if (current.rev !== expectedRev) throw practiceSharingConflict(current.rev);
    const roster = rosterFromState(current.state, current.rev);
    const context = assignmentContextFromRoster(userId, coachingRole, roster);
    if (!context || context.kind !== "student") {
      throw coachingError(404, "not_found", "Not found.");
    }
    const student = context.student;
    const coach = roster.coaches.find((item) => item && item.id === student.coachId);
    if (
      !coach
      || safeIdentity(input && input.coachId) !== coach.id
      || !safeIdentity(student.userId)
      || !safeIdentity(coach.userId)
    ) {
      throw coachingError(409, "practice_sharing_relationship_changed", "Your coaching relationship changed. Reload before responding.");
    }
    const sharing = practiceSharingSnapshot(student, coach);
    if (sharing.status !== "pending") {
      throw coachingError(409, "practice_sharing_not_pending", "This practice-sharing request is no longer pending.");
    }
    const now = this._assignmentNow();
    const practiceSharing = {
      version: 1,
      policyVersion: PRACTICE_SHARING_POLICY_VERSION,
      status: decision,
      studentUserId: student.userId,
      coachUserId: coach.userId,
      requestedAt: sharing.requestedAt || now,
      respondedAt: now,
      revokedAt: null,
      grantId: decision === "accepted" ? randomUUID() : null,
    };
    const state = replaceStudentPracticeSharing(current.state, student.id, practiceSharing);
    const result = await this.putState(
      state,
      current.rev,
      [userId, student.userId, coach.userId],
    );
    if (!result.ok) throw practiceSharingConflict(result.rev);
    this._notifyAssignment(coach.userId, {
      kind: `practice_sharing_${decision}`,
      studentName: safeAssignmentName(student.name, "Student"),
    });
    return {
      rev: result.rev,
      relationship: publicPracticeSharing({ ...student, practiceSharing }, coach),
    };
  }

  /**
   * Revoke an accepted relationship immediately. Every coach-facing
   * assignment summary, evidence page, and replay download consults this
   * live flag; the student retains access to their own plan history.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {Record<string, unknown>} input
   */
  async revokePracticeSharing(userId, coachingRole, input) {
    const expectedRev = practiceSharingRevision(input && input.expectedRev);
    const current = await this.getDoc();
    if (current.rev !== expectedRev) throw practiceSharingConflict(current.rev);
    const roster = rosterFromState(current.state, current.rev);
    const context = assignmentContextFromRoster(userId, coachingRole, roster);
    if (!context || context.kind !== "student") {
      throw coachingError(404, "not_found", "Not found.");
    }
    const student = context.student;
    const coach = roster.coaches.find((item) => item && item.id === student.coachId);
    if (
      !coach
      || safeIdentity(input && input.coachId) !== coach.id
      || !safeIdentity(student.userId)
      || !safeIdentity(coach.userId)
    ) {
      throw coachingError(409, "practice_sharing_relationship_changed", "Your coaching relationship changed. Reload before revoking access.");
    }
    const sharing = practiceSharingSnapshot(student, coach);
    if (sharing.status !== "accepted") {
      throw coachingError(409, "practice_sharing_not_accepted", "Practice sharing is not currently active.");
    }
    const now = this._assignmentNow();
    const practiceSharing = {
      ...sharing,
      version: 1,
      policyVersion: PRACTICE_SHARING_POLICY_VERSION,
      status: "revoked",
      studentUserId: student.userId,
      coachUserId: coach.userId,
      respondedAt: sharing.respondedAt || now,
      revokedAt: now,
    };
    const state = replaceStudentPracticeSharing(current.state, student.id, practiceSharing);
    const result = await this.putState(
      state,
      current.rev,
      [userId, student.userId, coach.userId],
    );
    if (!result.ok) throw practiceSharingConflict(result.rev);
    this._notifyAssignment(coach.userId, {
      kind: "practice_sharing_revoked",
      studentName: safeAssignmentName(student.name, "Student"),
    });
    return {
      rev: result.rev,
      relationship: publicPracticeSharing({ ...student, practiceSharing }, coach),
    };
  }

  /**
   * Create an idempotent, server-owned practice assignment. The replay query
   * and progress counters are never accepted from the client.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} studentId
   * @param {Record<string, unknown>} input
   */
  async createAssignment(userId, coachingRole, studentId, input) {
    const context = await this._assignmentContext(userId, coachingRole);
    if (context.kind === "student") {
      throw coachingError(404, "not_found", "Not found.");
    }
    const student = context.roster.students.find((/** @type {any} */ item) =>
      item
      && item.id === studentId
      && (context.kind === "admin" || item.coachId === context.coach.id),
    );
    const coach = student && context.roster.coaches.find((/** @type {any} */ item) =>
      item && item.id === student.coachId,
    );
    if (
      !student
      || !coach
      || !safeIdentity(student.userId)
      || !safeIdentity(coach.userId)
    ) {
      throw coachingError(404, "student_not_found", "The linked coaching student was not found.");
    }
    if (!practiceSharingAccepted(student, coach)) {
      throw coachingError(
        409,
        "practice_sharing_consent_required",
        "The student must accept practice and replay sharing before assignments can be created.",
      );
    }

    const requirement = normalizeGameRequirement(input);
    const requestFingerprint = assignmentRequirementFingerprint(requirement);
    const clientRequestId = normalizeClientRequestId(input.clientRequestId);
    const now = this._assignmentNow();
    const prior = await this.db.coaching.findOne({
      kind: ASSIGNMENT_KIND,
      coachId: coach.id,
      clientRequestId,
    });
    if (prior) {
      const priorFingerprint = safeIdentity(prior.requestFingerprint)
        || assignmentRequirementFingerprint(prior.requirement || {});
      if (
        prior.studentId !== student.id
        || prior.studentUserId !== student.userId
        || priorFingerprint !== requestFingerprint
      ) {
        throw coachingError(409, "assignment_request_conflict", "That assignment request identifier is already in use.");
      }
      this._authorizeAssignment(prior, context);
      return this._assignmentResponse(prior, context.roster, now);
    }

    if (toDate(requirement.endsAt) <= now) {
      throw coachingError(400, "invalid_assignment_window", "The assignment window must end in the future.");
    }
    const id = randomUUID();
    const doc = stampVersion({
      _id: assignmentDocumentId(id),
      kind: ASSIGNMENT_KIND,
      id,
      rev: 1,
      status: "active",
      clientRequestId,
      requestFingerprint,
      practiceSharingGrantId: practiceSharingSnapshot(student, coach).grantId,
      studentId: student.id,
      studentUserId: student.userId,
      studentName: safeAssignmentName(student.name, "Student"),
      coachId: coach.id,
      coachUserId: coach.userId,
      coachName: safeAssignmentName(coach.name, "Coach"),
      createdByUserId: userId,
      requirement,
      createdAt: now,
      updatedAt: now,
    }, COLLECTIONS.COACHING);
    try {
      await this._withCoachingMutation(
        [userId, student.userId, coach.userId],
        () => this.db.coaching.insertOne(doc),
      );
    } catch (error) {
      if (!error || /** @type {any} */ (error).code !== 11000) throw error;
      const winner = await this.db.coaching.findOne({
        kind: ASSIGNMENT_KIND,
        coachId: coach.id,
        clientRequestId,
      });
      const winnerFingerprint = winner && (safeIdentity(winner.requestFingerprint)
        || assignmentRequirementFingerprint(winner.requirement || {}));
      if (
        !winner
        || winner.studentId !== student.id
        || winner.studentUserId !== student.userId
        || winnerFingerprint !== requestFingerprint
      ) {
        throw coachingError(409, "assignment_request_conflict", "That assignment request identifier is already in use.");
      }
      this._authorizeAssignment(winner, context);
      return this._assignmentResponse(winner, context.roster, this._assignmentNow());
    }
    this._notifyAssignment(student.userId, {
      kind: "assigned",
      assignmentId: id,
      coachName: doc.coachName,
    });
    return this._assignmentResponse(doc, context.roster, now);
  }

  /**
   * List only assignments visible to the caller. A student retains their own
   * plan history after revoking coach access; coaches/admins require the exact
   * currently accepted account relationship and grant epoch.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {{studentId?:string,page?:number,limit?:number,paginated?:boolean}|undefined} options
   */
  async listAssignments(userId, coachingRole, options) {
    const context = await this._assignmentContext(userId, coachingRole);
    /** @type {Record<string, any>} */
    const filter = { kind: ASSIGNMENT_KIND };
    const requestedStudentId = safeIdentity(options && options.studentId);
    const paginated = Boolean(options && options.paginated);
    const page = boundedPositiveInteger(options && options.page, 1, 10_000, 1);
    const limit = boundedPositiveInteger(
      options && options.limit,
      1,
      ASSIGNMENT_LIST_CAP,
      ASSIGNMENT_LIST_DEFAULT,
    );
    if (context.kind === "student") {
      if (requestedStudentId && requestedStudentId !== context.student.id) {
        throw coachingError(404, "student_not_found", "The linked coaching student was not found.");
      }
      filter.studentId = context.student.id;
      filter.studentUserId = context.student.userId;
    } else {
      let relationships = acceptedPracticeRelationships(context.roster);
      if (context.kind === "coach") {
        relationships = relationships.filter((item) =>
          item.coachId === context.coach.id
          && item.coachUserId === context.coach.userId,
        );
      }
      if (requestedStudentId) {
        const allowed = relationships.some((item) => item.studentId === requestedStudentId);
        if (!allowed) throw coachingError(404, "student_not_found", "The linked coaching student was not found.");
        relationships = relationships.filter((item) => item.studentId === requestedStudentId);
      }
      if (relationships.length === 0) {
        return paginated ? { assignments: [], page, limit, hasMore: false } : [];
      }
      filter.$or = relationships;
    }
    const requestedLimit = paginated ? limit : ASSIGNMENT_LIST_CAP;
    const docs = await this.db.coaching
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(paginated ? (page - 1) * limit : 0)
      .limit(requestedLimit + (paginated ? 1 : 0))
      .toArray();
    const now = this._assignmentNow();
    const assignments = await Promise.all(docs.slice(0, requestedLimit).map((doc) =>
      this._assignmentResponse(doc, context.roster, now, { includeGames: false }),
    ));
    return paginated
      ? { assignments, page, limit, hasMore: docs.length > limit }
      : assignments;
  }

  /**
   * Page replay evidence independently from the assignment summary so a
   * collapsed coaching workspace never downloads or renders thousands of
   * game rows. Authorization and assignment eligibility are re-applied on
   * every page read.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} assignmentId
   * @param {{page?:number,limit?:number}|undefined} options
   */
  async assignmentGames(userId, coachingRole, assignmentId, options) {
    const context = await this._assignmentContext(userId, coachingRole);
    const assignment = await this._assignmentDocument(assignmentId);
    this._authorizeAssignment(assignment, context);
    const page = boundedPositiveInteger(options && options.page, 1, 10_000, 1);
    const limit = boundedPositiveInteger(options && options.limit, 1, 100, 25);
    const match = assignmentGameMatch(assignment);
    const [total, rows] = await Promise.all([
      this.db.games.countDocuments(match),
      this.db.games.find(match, { projection: assignmentGameProjection() })
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
    ]);
    return {
      assignmentId: assignment.id,
      page,
      limit,
      total,
      hasMore: page * limit < total,
      games: rows.map((game) => serializeAssignmentGame(assignment.id, game)),
    };
  }

  /**
   * Cancel a requirement with optimistic concurrency. Requirements are
   * immutable after assignment so an edit cannot retroactively claim games
   * played before a materially different target existed.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} assignmentId
   * @param {Record<string, unknown>} input
   */
  async replaceAssignment(userId, coachingRole, assignmentId, input) {
    const context = await this._assignmentContext(userId, coachingRole);
    if (context.kind === "student") {
      throw coachingError(404, "not_found", "Not found.");
    }
    const current = await this._assignmentDocument(assignmentId);
    this._authorizeAssignment(current, context);
    const expectedRev = Number(input.expectedRev);
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw coachingError(400, "invalid_assignment_revision", "expectedRev must be a positive integer.");
    }
    if (input.status !== "cancelled") {
      throw coachingError(400, "invalid_assignment_status", "status must be cancelled.");
    }
    if (current.status === "cancelled") {
      throw coachingError(409, "assignment_cancelled", "Cancelled assignments cannot be reactivated.");
    }
    const updatedAt = this._assignmentNow();
    const progress = await this._assignmentProgress(current, updatedAt, { includeGames: false });
    if (progress.state !== "active" && progress.state !== "upcoming") {
      throw coachingError(409, "assignment_not_cancellable", "Completed or ended assignments cannot be cancelled.");
    }
    const update = stampVersion({
      status: "cancelled",
      cancelledAt: updatedAt,
      rev: expectedRev + 1,
      updatedAt,
    }, COLLECTIONS.COACHING);
    const result = await this._withCoachingMutation(
      [userId, current.studentUserId, current.coachUserId, current.createdByUserId],
      () => this.db.coaching.updateOne(
        {
          _id: current._id,
          kind: ASSIGNMENT_KIND,
          rev: expectedRev,
        },
        { $set: update },
      ),
    );
    if (result.matchedCount !== 1) {
      const latest = await this._assignmentDocument(assignmentId);
      this._authorizeAssignment(latest, context);
      throw coachingError(409, "assignment_conflict", `Assignment changed in another tab (current revision ${latest.rev || 0}).`);
    }
    const next = { ...current, ...update };
    this._notifyAssignment(current.studentUserId, {
      kind: "cancelled",
      assignmentId: current.id,
      coachName: current.coachName,
    });
    return this._assignmentResponse(next, context.roster, updatedAt);
  }

  /**
   * Re-authorize an assignment game immediately before asking the private
   * replay store for a signed URL. A coach cannot use this as a general
   * cross-account replay download primitive.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} assignmentId
   * @param {string} gameId
   */
  async assignmentReplayOwner(userId, coachingRole, assignmentId, gameId) {
    const context = await this._assignmentContext(userId, coachingRole);
    const assignment = await this._assignmentDocument(assignmentId);
    this._authorizeAssignment(assignment, context);
    const safeGameId = safeIdentity(gameId);
    if (!safeGameId || safeGameId.length > 200) {
      throw coachingError(404, "replay_not_found", "The assigned replay was not found.");
    }
    const game = await this.db.games.findOne(
      { ...assignmentGameMatch(assignment), gameId: safeGameId },
      { projection: { _id: 0, gameId: 1 } },
    );
    if (!game) {
      throw coachingError(404, "replay_not_found", "The assigned replay was not found.");
    }
    return { userId: assignment.studentUserId, gameId: safeGameId };
  }

  /** @param {string} assignmentId */
  async _assignmentDocument(assignmentId) {
    const id = safeIdentity(assignmentId);
    if (!id || id.length > 100) {
      throw coachingError(404, "assignment_not_found", "The coaching assignment was not found.");
    }
    const doc = await this.db.coaching.findOne(/** @type {any} */ ({
      _id: assignmentDocumentId(id),
      kind: ASSIGNMENT_KIND,
    }));
    if (!doc) {
      throw coachingError(404, "assignment_not_found", "The coaching assignment was not found.");
    }
    return doc;
  }

  /**
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   */
  async _assignmentContext(userId, coachingRole) {
    const roster = await this.getRoster();
    const context = assignmentContextFromRoster(userId, coachingRole, roster);
    if (context) return context;
    throw coachingError(404, "not_found", "Not found.");
  }

  /** @param {any} assignment @param {any} context */
  _authorizeAssignment(assignment, context) {
    const student = context.roster.students.find((/** @type {any} */ item) => item
      && item.id === assignment.studentId
      && item.userId === assignment.studentUserId);
    if (
      student
      && context.kind === "student"
      && student.id === context.student.id
      && student.userId === context.student.userId
    ) return;
    const coach = student && context.roster.coaches.find((/** @type {any} */ item) => item
      && item.id === assignment.coachId
      && item.userId === assignment.coachUserId);
    if (
      !student
      || !coach
      || !safeIdentity(assignment.coachUserId)
      || !practiceSharingAccepted(student, coach)
      || assignment.practiceSharingGrantId !== practiceSharingSnapshot(student, coach).grantId
    ) {
      throw coachingError(404, "assignment_not_found", "The coaching assignment was not found.");
    }
    if (context.kind === "admin") return;
    if (
      context.kind === "coach"
      && coach.id === context.coach.id
      && coach.userId === context.coach.userId
    ) return;
    throw coachingError(404, "assignment_not_found", "The coaching assignment was not found.");
  }

  /**
   * @param {any} assignment
   * @param {any} roster
   * @param {Date} now
   * @param {{includeGames?:boolean}|undefined} options
   */
  async _assignmentResponse(assignment, roster, now, options = undefined) {
    const student = roster.students.find((/** @type {any} */ item) => item
      && item.id === assignment.studentId
      && item.userId === assignment.studentUserId);
    const coach = roster.coaches.find((/** @type {any} */ item) => item
      && item.id === assignment.coachId
      && item.userId === assignment.coachUserId);
    return {
      id: assignment.id,
      rev: nonNegativeInteger(assignment.rev),
      status: assignment.status === "cancelled" ? "cancelled" : "active",
      student: {
        id: assignment.studentId,
        name: safeAssignmentName(student && student.name, assignment.studentName || "Student"),
      },
      coach: {
        id: assignment.coachId,
        name: safeAssignmentName(coach && coach.name, assignment.coachName || "Coach"),
      },
      requirement: serializeGameRequirement(assignment.requirement),
      createdAt: assignmentDateIso(assignment.createdAt),
      updatedAt: assignmentDateIso(assignment.updatedAt),
      progress: await this._assignmentProgress(assignment, now, options),
    };
  }

  /**
   * @param {any} assignment
   * @param {Date} now
   * @param {{includeGames?:boolean}|undefined} options
   */
  async _assignmentProgress(assignment, now, options) {
    const requirement = assignment.requirement;
    const bounds = assignmentEffectiveBounds(assignment);
    const buckets = assignmentBuckets(requirement)
      .filter((bucket) =>
        Date.parse(String(bucket.endsAt || "")) > bounds.startsAt.getTime()
        && Date.parse(String(bucket.startsAt || "")) < bounds.endsAt.getTime())
      .map((bucket) => ({
        ...bucket,
        startsAt: new Date(Math.max(
          Date.parse(String(bucket.startsAt || "")),
          bounds.startsAt.getTime(),
        )).toISOString(),
        endsAt: new Date(Math.min(
          Date.parse(String(bucket.endsAt || "")),
          bounds.endsAt.getTime(),
        )).toISOString(),
      }));
    const match = assignmentGameMatch(assignment);
    const groupExpression = assignmentGroupExpression(requirement);
    const countPipeline = groupExpression
      ? [
        { $match: match },
        { $group: { _id: groupExpression, playedGames: { $sum: 1 } } },
      ]
      : [
        { $match: match },
        { $count: "playedGames" },
      ];
    const includeGames = !options || options.includeGames !== false;
    const [countRows, gameRows] = await Promise.all([
      this.db.games.aggregate(countPipeline).toArray(),
      includeGames
        ? this.db.games.find(match, {
          projection: assignmentGameProjection(),
        })
          .sort({ date: -1, _id: -1 })
          .limit(ASSIGNMENT_GAME_LIST_CAP + 1)
          .toArray()
        : Promise.resolve([]),
    ]);
    const counts = assignmentCountsByBucket(requirement, countRows);
    const gamesTruncated = gameRows.length > ASSIGNMENT_GAME_LIST_CAP;
    const replayGames = gameRows
      .slice(0, ASSIGNMENT_GAME_LIST_CAP)
      .map((game) => serializeAssignmentGame(assignment.id, game));
    const summaries = buckets.map((bucket) => {
      const playedGames = counts.get(bucket.key) || 0;
      return {
        ...bucket,
        playedGames,
        requiredGames: requirement.requiredGames,
        remainingGames: Math.max(0, requirement.requiredGames - playedGames),
        complete: playedGames >= requirement.requiredGames,
      };
    });
    const nowMs = now.getTime();
    const cancelledAtMs = assignment.status === "cancelled"
      ? toDate(assignment.cancelledAt).getTime()
      : 0;
    const progressAtMs = cancelledAtMs > 0
      ? Math.min(nowMs, cancelledAtMs - 1)
      : nowMs;
    const currentBucket = summaries.find((bucket) =>
      Date.parse(String(bucket.startsAt || "")) <= progressAtMs
      && progressAtMs < Date.parse(String(bucket.endsAt || "")),
    ) || null;
    const playedGames = summaries.reduce((total, bucket) => total + bucket.playedGames, 0);
    const completedBuckets = summaries.filter((bucket) => bucket.complete).length;
    const startsAt = bounds.startsAt.getTime();
    const endsAt = bounds.endsAt.getTime();
    let state = "active";
    if (assignment.status === "cancelled") state = "cancelled";
    else if (nowMs < startsAt) state = "upcoming";
    else if (requirement.recurrence === "once" && completedBuckets === 1) state = "met";
    else if (nowMs >= endsAt) {
      state = summaries.length > 0 && completedBuckets === summaries.length ? "met" : "missed";
    }
    const currentGames = currentBucket
      ? replayGames.filter((game) => {
        const at = Date.parse(String(game.date || ""));
        return at >= Date.parse(String(currentBucket.startsAt || ""))
          && at < Date.parse(String(currentBucket.endsAt || ""));
      })
      : [];
    return {
      state,
      playedGames,
      requiredGamesTotal: requirement.requiredGames * summaries.length,
      completedBuckets,
      totalBuckets: summaries.length,
      currentBucket: currentBucket ? { ...currentBucket, games: currentGames } : null,
      buckets: summaries,
      games: currentGames,
      replayGames,
      replayGameCount: playedGames,
      gamesTruncated,
    };
  }

  /** @param {string|undefined|null} userId @param {Record<string,unknown>} payload */
  _notifyAssignment(userId, payload) {
    if (!this.io || !userId) return;
    try {
      this.io.to(`user:${userId}`).emit("coaching:assignment", payload);
    } catch (err) {
      if (this.logger) this.logger.warn({ err, userId }, "coaching_assignment_notification_failed");
    }
  }

  /**
   * Return the caller's scheduling workspace. Students receive only their
   * own bookings plus concrete UTC slots for their attached coach. Coaches
   * receive their availability editor data and calendar.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string|undefined} viewerTimeZone
   */
  async calendarFor(userId, coachingRole, viewerTimeZone) {
    const actor = await this._scheduleActor(userId, coachingRole);
    const doc = await this._calendarDoc(actor.coach.id);
    const zone = canonicalTimeZone(viewerTimeZone) || "UTC";
    const allVisible = visibleBookings(doc, actor, new Date());
    const allVisibleIds = new Set(allVisible.map((booking) => booking.id));
    const visibleUnread = unreadBookings(doc, actor, userId)
      .filter((booking) => allVisibleIds.has(booking.id));
    const selectedIds = new Set();
    const visible = [...visibleUnread, ...allVisible]
      .filter((booking) => {
        if (selectedIds.has(booking.id)) return false;
        selectedIds.add(booking.id);
        return true;
      })
      .slice(0, MAX_BOOKINGS_RETURNED)
      .sort((a, b) => toDate(a.startAt).getTime() - toDate(b.startAt).getTime());
    const unreadAlerts = visibleUnread
      .filter((booking) => selectedIds.has(booking.id))
      .slice(0, MAX_BOOKINGS_RETURNED)
      .map((booking) => ({
        bookingId: booking.id,
        updatedAt: toDate(booking.updatedAt || booking.createdAt).toISOString(),
      }));
    const bookings = visible.map(publicBooking);
    const availability = doc && doc.availability
      ? publicAvailability(
        doc.availability,
        doc.availabilityUpdatedAt || doc.updatedAt,
        doc.availabilityEnabled !== false,
      )
      : null;
    const slots = actor.kind === "student" && availability && availability.enabled && doc && doc.availability
      ? buildAvailableSlots(doc.availability, doc.bookings || [], new Date())
      : [];
    return {
      role: actor.kind,
      coach: { id: actor.coach.id, name: actor.coach.name || "Coach" },
      viewerTimeZone: zone,
      availabilityRev: Number(doc && doc.availabilityRev) || 0,
      availability,
      bookings,
      unreadAlerts,
      slots,
    };
  }

  /**
   * Replace the signed-in coach's recurring weekly availability. Existing
   * bookings remain authoritative even if a coach later narrows their hours.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {{expectedRev?:unknown,[key:string]:unknown}|undefined} input
   */
  async saveAvailability(userId, coachingRole, input) {
    const actor = await this._scheduleActor(userId, coachingRole);
    if (actor.kind !== "coach") {
      throw coachingError(403, "coach_required", "Only coaches can publish availability.");
    }
    const availability = normalizeAvailability(input);
    const expectedRev = Number(input && input.expectedRev);
    if (!Number.isInteger(expectedRev) || expectedRev < 0) {
      throw coachingError(400, "invalid_revision", "Reload Coaching and try saving availability again.");
    }
    const at = new Date();
    const stamped = stampVersion(
      {
        coachId: actor.coach.id,
        coachName: actor.coach.name || "Coach",
        coachUserId: userId,
        availability,
        availabilityEnabled: true,
        availabilityUpdatedAt: at,
        updatedAt: at,
      },
      COLLECTIONS.COACHING,
    );
    let result;
    try {
      result = await this._withCoachingMutation(
        [userId, actor.coach.userId],
        () => this.db.coaching.updateOne(
          /** @type {any} */ ({
            _id: calendarId(actor.coach.id),
            ...(expectedRev === 0
              ? { $or: [{ availabilityRev: 0 }, { availabilityRev: { $exists: false } }] }
              : { availabilityRev: expectedRev }),
          }),
          {
            $set: stamped,
            $setOnInsert: {
              createdAt: at,
              bookings: [],
            },
            $inc: { availabilityRev: 1, calendarRev: 1 },
          },
          { upsert: expectedRev === 0 },
        ),
      );
    } catch (error) {
      if (!error || /** @type {any} */ (error).code !== 11000) throw error;
      result = null;
    }
    if (!result || (result.matchedCount !== 1 && result.upsertedCount !== 1)) {
      throw coachingError(409, "availability_conflict", "Availability changed in another tab. Reload and review it before saving again.");
    }
    return this.calendarFor(userId, coachingRole, availability.timeZone);
  }

  /**
   * Pause new bookings without discarding the coach's configured hours.
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {{expectedRev?:unknown}|undefined} input
   */
  async pauseAvailability(userId, coachingRole, input) {
    const actor = await this._scheduleActor(userId, coachingRole);
    if (actor.kind !== "coach") {
      throw coachingError(403, "coach_required", "Only coaches can pause availability.");
    }
    const expectedRev = Number(input && input.expectedRev);
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw coachingError(400, "invalid_revision", "Reload Coaching and try pausing availability again.");
    }
    const at = new Date();
    const result = await this._withCoachingMutation(
      [userId, actor.coach.userId],
      () => this.db.coaching.updateOne(
        /** @type {any} */ ({
          _id: calendarId(actor.coach.id),
          availabilityRev: expectedRev,
        }),
        {
          $set: {
            availabilityEnabled: false,
            availabilityUpdatedAt: at,
            updatedAt: at,
          },
          $inc: { availabilityRev: 1, calendarRev: 1 },
        },
      ),
    );
    if (result.modifiedCount !== 1) {
      throw coachingError(409, "availability_conflict", "Availability changed in another tab. Reload and review it before pausing.");
    }
    return this.calendarFor(userId, coachingRole, actor.coach.timeZone);
  }

  /**
   * Atomically reserve one of the attached coach's generated slots. The
   * no-overlap predicate and write happen in the same Mongo update, so two
   * students clicking the same opening cannot both succeed.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {{startAt?:unknown,durationMinutes?:unknown}} input
   */
  async bookSession(userId, coachingRole, input) {
    const actor = await this._scheduleActor(userId, coachingRole);
    if (actor.kind !== "student") {
      throw coachingError(403, "student_required", "Only attached students can book a session.");
    }
    const doc = await this._calendarDoc(actor.coach.id);
    if (!doc || !doc.availability || doc.availabilityEnabled === false) {
      throw coachingError(409, "availability_missing", "Your coach is not accepting new bookings right now.");
    }
    // The route's role snapshot can become stale while the calendar is read.
    // Resolve the attachment again after that read; any later roster change
    // increments rosterRev/locks the calendar and is caught by the atomic
    // predicate below.
    const currentActor = await this._scheduleActor(userId, coachingRole);
    if (
      currentActor.kind !== "student" ||
      currentActor.student.id !== actor.student.id ||
      currentActor.coach.id !== actor.coach.id
    ) {
      throw coachingError(409, "assignment_changed", "Your coach assignment changed. Reload Coaching before booking.");
    }
    const durationMinutes = Number(input && input.durationMinutes);
    const startAt = parseDate(input && input.startAt);
    if (!startAt || !Number.isInteger(durationMinutes)) {
      throw coachingError(400, "invalid_booking", "Choose a valid available session.");
    }
    const existing = findMatchingBooking(
      doc.bookings,
      userId,
      startAt,
      durationMinutes,
    );
    if (existing) return { booking: publicBooking(existing) };
    const candidate = buildAvailableSlots(doc.availability, [], new Date())
      .find((slot) =>
        slot.startAt === startAt.toISOString() &&
        slot.durationMinutes === durationMinutes,
      );
    if (!candidate) {
      throw coachingError(409, "slot_unavailable", "That time is no longer available.");
    }
    const endAt = new Date(candidate.endAt);
    const at = new Date();
    const booking = {
      id: randomUUID(),
      studentId: actor.student.id,
      studentUserId: userId,
      studentName: actor.student.name || "Student",
      startAt,
      endAt,
      durationMinutes,
      status: "booked",
      createdAt: at,
      updatedAt: at,
      coachReadAt: null,
      studentReadAt: at,
      cancelledAt: null,
      cancelledBy: null,
    };
    const result = await this._withCoachingMutation(
      [userId, actor.coach.userId],
      () => this.db.coaching.updateOne(
        /** @type {any} */ ({
          _id: calendarId(actor.coach.id),
          availabilityRev: doc.availabilityRev,
          availabilityEnabled: { $ne: false },
          rosterRev: doc.rosterRev == null ? null : doc.rosterRev,
          $or: [
            { rosterLock: { $exists: false } },
            { rosterLockExpiresAt: { $lte: at } },
          ],
          $nor: [{
            bookings: {
              $elemMatch: {
                status: "booked",
                startAt: { $lt: endAt },
                endAt: { $gt: startAt },
              },
            },
          }],
        }),
        /** @type {any} */ ({
          $push: { bookings: booking },
          $set: { updatedAt: at },
          $inc: { calendarRev: 1 },
        }),
      ),
    );
    if (result.modifiedCount !== 1) {
      const latest = await this._calendarDoc(actor.coach.id);
      const committed = findMatchingBooking(
        latest && latest.bookings,
        userId,
        startAt,
        durationMinutes,
      );
      if (committed) return { booking: publicBooking(committed) };
      throw coachingError(409, "slot_unavailable", "That time was just booked. Choose another opening.");
    }
    this._notify(actor.coach.userId, {
      bookingId: booking.id,
      kind: "booked",
      startAt: booking.startAt.toISOString(),
    });
    return { booking: publicBooking(booking) };
  }

  /**
   * Cancel an upcoming booking. Coaches may cancel anything on their own
   * calendar; students may cancel only their own booking.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {string} bookingId
   */
  async cancelSession(userId, coachingRole, bookingId) {
    const actor = await this._scheduleActor(userId, coachingRole);
    const doc = await this._calendarDoc(actor.coach.id);
    const booking = doc && Array.isArray(doc.bookings)
      ? doc.bookings.find((item) => item && item.id === bookingId)
      : null;
    if (!booking || (actor.kind === "student" && booking.studentUserId !== userId)) {
      throw coachingError(404, "booking_not_found", "Booking not found.");
    }
    if (booking.status !== "booked") {
      return { ok: true, alreadyCancelled: true };
    }
    if (toDate(booking.startAt).getTime() <= Date.now()) {
      throw coachingError(409, "booking_started", "Sessions cannot be cancelled after they start.");
    }
    const at = new Date();
    const isCoach = actor.kind === "coach";
    /** @type {Record<string,unknown>} */
    const set = {
      "bookings.$.status": "cancelled",
      "bookings.$.cancelledAt": at,
      "bookings.$.cancelledBy": isCoach ? "coach" : "student",
      "bookings.$.updatedAt": at,
      updatedAt: at,
    };
    if (isCoach) {
      set["bookings.$.coachReadAt"] = at;
      set["bookings.$.studentReadAt"] = null;
    } else {
      set["bookings.$.coachReadAt"] = null;
      set["bookings.$.studentReadAt"] = at;
    }
    const filter = /** @type {any} */ ({
      _id: calendarId(actor.coach.id),
      bookings: {
        $elemMatch: {
          id: bookingId,
          status: "booked",
          ...(isCoach ? {} : { studentUserId: userId }),
        },
      },
    });
    const result = await this._withCoachingMutation(
      [userId, actor.coach.userId, booking.studentUserId],
      () => this.db.coaching.updateOne(
        filter,
        { $set: set, $inc: { calendarRev: 1 } },
      ),
    );
    if (result.modifiedCount !== 1) {
      throw coachingError(409, "booking_cancelled", "That booking was already changed.");
    }
    const recipient = isCoach ? booking.studentUserId : actor.coach.userId;
    this._notify(recipient, {
      bookingId,
      kind: "cancelled",
      startAt: toDate(booking.startAt).toISOString(),
    });
    return { ok: true };
  }

  /**
   * Small, privacy-safe header probe. Accounts outside coaching receive an
   * ineligible response so the private route remains undiscoverable in UI.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   */
  async alertSummary(userId, coachingRole) {
    if (!coachingRole || coachingRole.role === "none") {
      return { eligible: false, unreadCount: 0, alert: null };
    }
    const actor = await this._scheduleActor(userId, coachingRole);
    const doc = await this._calendarDoc(actor.coach.id);
    const visibleIds = new Set(
      visibleBookings(doc, actor, new Date()).map((booking) => booking.id),
    );
    const unread = unreadBookings(doc, actor, userId)
      .filter((booking) => visibleIds.has(booking.id))
      .slice(0, MAX_BOOKINGS_RETURNED);
    const latest = unread[0] || null;
    return {
      eligible: true,
      unreadCount: unread.length,
      alert: latest ? publicAlert(latest, actor.kind) : null,
    };
  }

  /**
   * Mark only the alert snapshot the caller actually rendered. Passing IDs
   * prevents a booking committed between calendar GET and this POST from
   * being silently acknowledged. Student filters also ensure one student
   * can never clear another student's cancellation alert.
   *
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   * @param {{alerts?:unknown}|undefined} input
   */
  async markAlertsRead(userId, coachingRole, input) {
    const actor = await this._scheduleActor(userId, coachingRole);
    const rawAlerts = input && Array.isArray(input.alerts)
      ? input.alerts
      : [];
    if (rawAlerts.length > MAX_BOOKINGS_RETURNED) {
      throw coachingError(400, "invalid_alerts", "Too many coaching alerts were supplied.");
    }
    const seen = new Set();
    const alerts = /** @type {Array<{bookingId:string,updatedAt:Date}>} */ (rawAlerts.map((alert) => {
      const bookingId = alert && typeof alert.bookingId === "string"
        ? alert.bookingId
        : "";
      const updatedAt = parseDate(alert && alert.updatedAt);
      const key = `${bookingId}:${updatedAt ? updatedAt.toISOString() : ""}`;
      if (!bookingId || bookingId.length > 128 || !updatedAt || seen.has(key)) return null;
      seen.add(key);
      return { bookingId, updatedAt };
    }).filter((alert) => alert !== null));
    if (alerts.length === 0) return { ok: true };
    const field = actor.kind === "coach" ? "coachReadAt" : "studentReadAt";
    const at = new Date();
    const bookingFilter = {
      $or: alerts.map((alert) => ({
        "booking.id": alert.bookingId,
        "booking.updatedAt": alert.updatedAt,
      })),
      [`booking.${field}`]: null,
      ...(actor.kind === "student"
        ? { "booking.studentUserId": userId }
        : {}),
    };
    await this._withCoachingMutation(
      [userId, actor.coach.userId],
      () => this.db.coaching.updateOne(
        /** @type {any} */ ({ _id: calendarId(actor.coach.id) }),
        {
          $set: {
            [`bookings.$[booking].${field}`]: at,
            updatedAt: at,
          },
        },
        { arrayFilters: [bookingFilter] },
      ),
    );
    return { ok: true };
  }

  /** @param {string} coachId */
  async _calendarDoc(coachId) {
    return this.db.coaching.findOne(
      /** @type {any} */ ({ _id: calendarId(coachId) }),
    );
  }

  /**
   * @param {string} userId
   * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
   */
  async _scheduleActor(userId, coachingRole) {
    const { coaches, students } = await this.getRoster();
    if (coachingRole.role === "admin" || coachingRole.role === "coach") {
      const coach = coaches.find((item) => item && item.id === coachingRole.coachId);
      if (!coach) throw coachingError(404, "coach_not_found", "Coaching access is not configured.");
      return { kind: "coach", coach };
    }
    if (coachingRole.role === "student") {
      const student = students.find((item) => item && item.id === coachingRole.studentId && item.userId === userId);
      const coach = student && coaches.find((item) => item && item.id === student.coachId);
      if (!student || !coach) {
        throw coachingError(404, "coach_not_found", "Your attached coach is not configured.");
      }
      return { kind: "student", coach, student };
    }
    throw coachingError(404, "not_found", "Not found.");
  }

  /** @param {string|undefined|null} userId @param {Record<string,unknown>} payload */
  _notify(userId, payload) {
    if (!this.io || !userId) return;
    try {
      this.io.to(`user:${userId}`).emit("coaching:booking", payload);
    } catch (err) {
      if (this.logger) this.logger.warn({ err, userId }, "coaching_notification_failed");
    }
  }
}

/** @param {string} id */
function assignmentDocumentId(id) {
  return `${ASSIGNMENT_PREFIX}${id}`;
}

/**
 * Resolve an assignment actor against the exact live account ids in a roster.
 * @param {string} userId
 * @param {{role:string,coachId?:string,studentId?:string}} coachingRole
 * @param {{coaches:any[],students:any[],rev:number}} roster
 * @returns {any|null}
 */
function assignmentContextFromRoster(userId, coachingRole, roster) {
  if (coachingRole.role === "admin") return { kind: "admin", roster };
  if (coachingRole.role === "coach") {
    const coach = roster.coaches.find((item) =>
      item && item.id === coachingRole.coachId && item.userId === userId,
    );
    if (coach) return { kind: "coach", coach, roster };
  }
  if (coachingRole.role === "student") {
    const student = roster.students.find((item) =>
      item && item.id === coachingRole.studentId && item.userId === userId,
    );
    if (student) return { kind: "student", student, roster };
  }
  return null;
}

/** @param {any} student @param {any} coach */
function practiceSharingSnapshot(student, coach) {
  const raw = student && student.practiceSharing && typeof student.practiceSharing === "object"
    ? student.practiceSharing
    : {};
  const exact = Boolean(
    student
    && coach
    && safeIdentity(student.userId)
    && safeIdentity(coach.userId)
    && raw.studentUserId === student.userId
    && raw.coachUserId === coach.userId,
  );
  const allowedStatuses = new Set(["pending", "accepted", "rejected", "revoked"]);
  const exactPolicy = exact && raw.policyVersion === PRACTICE_SHARING_POLICY_VERSION;
  const status = exactPolicy && allowedStatuses.has(raw.status) ? raw.status : "pending";
  return {
    version: 1,
    policyVersion: exactPolicy
      ? raw.policyVersion
      : PRACTICE_SHARING_POLICY_VERSION,
    status,
    studentUserId: student && student.userId,
    coachUserId: coach && coach.userId,
    requestedAt: exactPolicy ? raw.requestedAt || null : null,
    respondedAt: exactPolicy ? raw.respondedAt || null : null,
    revokedAt: exactPolicy ? raw.revokedAt || null : null,
    grantId: exactPolicy ? safeIdentity(raw.grantId) || null : null,
  };
}

/** @param {any} student @param {any} coach */
function practiceSharingAccepted(student, coach) {
  const sharing = practiceSharingSnapshot(student, coach);
  return sharing.status === "accepted"
    && sharing.policyVersion === PRACTICE_SHARING_POLICY_VERSION
    && Boolean(sharing.grantId);
}

/** @param {any} student @param {any} coach */
function publicPracticeSharing(student, coach) {
  const sharing = practiceSharingSnapshot(student, coach);
  return {
    student: {
      id: student.id,
      name: safeAssignmentName(student.name, "Student"),
    },
    coach: {
      id: coach.id,
      name: safeAssignmentName(coach.name, "Coach"),
    },
    status: sharing.status,
    requestedAt: assignmentDateIso(sharing.requestedAt),
    respondedAt: assignmentDateIso(sharing.respondedAt),
    revokedAt: assignmentDateIso(sharing.revokedAt),
    policyVersion: PRACTICE_SHARING_POLICY_VERSION,
    scope: {
      practiceAssignments: true,
      qualifyingOneVsOneGameDetails: true,
      archivedOriginalReplays: true,
    },
  };
}

/** @param {{coaches:any[],students:any[]}} roster */
function acceptedPracticeRelationships(roster) {
  return roster.students.flatMap((student) => {
    const coach = roster.coaches.find((item) =>
      item && student && item.id === student.coachId,
    );
    if (!student || !coach || !practiceSharingAccepted(student, coach)) return [];
    return [{
      studentId: student.id,
      studentUserId: student.userId,
      coachId: coach.id,
      coachUserId: coach.userId,
      practiceSharingGrantId: practiceSharingSnapshot(student, coach).grantId,
    }];
  });
}

/**
 * Preserve a student's decision across ordinary Locker writes and reset it to
 * pending when either side of the account relationship changes.
 * @param {Record<string, any>} previous
 * @param {Record<string, any>} next
 * @param {Date} now
 */
function guardPracticeSharingState(previous, next, now) {
  const previousStudents = new Map(
    (Array.isArray(previous.students) ? previous.students : [])
      .filter(Boolean)
      .map((student) => [student.id, student]),
  );
  const nextCoaches = new Map(
    (Array.isArray(next.coaches) ? next.coaches : [])
      .filter(Boolean)
      .map((coach) => [coach.id, coach]),
  );
  const students = (Array.isArray(next.students) ? next.students : []).map((student) => {
    if (!student || typeof student !== "object") return student;
    const coach = nextCoaches.get(student.coachId);
    if (!safeIdentity(student.userId) || !coach || !safeIdentity(coach.userId)) {
      const withoutSharing = { ...student };
      delete withoutSharing.practiceSharing;
      return withoutSharing;
    }
    const before = previousStudents.get(student.id);
    if (
      before
      && before.userId === student.userId
      && before.coachId === student.coachId
      && before.practiceSharing
      && before.practiceSharing.studentUserId === student.userId
      && before.practiceSharing.coachUserId === coach.userId
      && before.practiceSharing.policyVersion === PRACTICE_SHARING_POLICY_VERSION
    ) {
      return { ...student, practiceSharing: before.practiceSharing };
    }
    return {
      ...student,
      practiceSharing: {
        version: 1,
        policyVersion: PRACTICE_SHARING_POLICY_VERSION,
        status: "pending",
        studentUserId: student.userId,
        coachUserId: coach.userId,
        requestedAt: now,
        respondedAt: null,
        revokedAt: null,
        grantId: null,
      },
    };
  });
  return { ...next, students };
}

/** @param {Record<string,any>} state @param {string} studentId @param {any} sharing */
function replaceStudentPracticeSharing(state, studentId, sharing) {
  return {
    ...state,
    students: (Array.isArray(state.students) ? state.students : []).map((student) =>
      student && student.id === studentId
        ? { ...student, practiceSharing: sharing }
        : student,
    ),
  };
}

/** @param {unknown} value */
function practiceSharingRevision(value) {
  const rev = Number(value);
  if (!Number.isInteger(rev) || rev < 1) {
    throw coachingError(400, "invalid_practice_sharing_revision", "expectedRev must be a positive integer.");
  }
  return rev;
}

/** @param {number} currentRev */
function practiceSharingConflict(currentRev) {
  return coachingError(
    409,
    "practice_sharing_conflict",
    `Coaching access changed in another tab (current revision ${currentRev}).`,
  );
}

/** @param {unknown} value @returns {string} */
function normalizeClientRequestId(value) {
  const id = safeIdentity(value);
  if (!id || id.length < 8 || id.length > 100 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw coachingError(
      400,
      "invalid_assignment_request_id",
      "clientRequestId must be 8-100 letters, numbers, underscores, or hyphens.",
    );
  }
  return id;
}

/** @param {unknown} value @returns {string} */
function safeIdentity(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** @param {unknown} value @param {string} fallback */
function safeAssignmentName(value, fallback) {
  const text = safeIdentity(value);
  return text ? text.slice(0, 160) : fallback;
}

/** @param {unknown} value @param {number} maxLength @param {string} field */
function optionalAssignmentText(value, maxLength, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw coachingError(400, "invalid_assignment", `${field} must be ${maxLength} characters or fewer.`);
  }
  return value.trim() || null;
}

/**
 * The public create/update payload uses inclusive local calendar dates. The
 * stored UTC end is the following local midnight and is always exclusive.
 * @param {unknown} value
 */
function normalizeGameRequirement(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coachingError(400, "invalid_assignment", "An assignment definition is required.");
  }
  const input = /** @type {Record<string, unknown>} */ (value);
  const type = input.type === "build" || input.type === "total"
    ? input.type
    : null;
  if (!type) {
    throw coachingError(400, "invalid_assignment_type", "type must be build or total.");
  }
  const requiredGames = Number(input.requiredGames);
  if (
    !Number.isInteger(requiredGames)
    || requiredGames < 1
    || requiredGames > ASSIGNMENT_MAX_REQUIRED_GAMES
  ) {
    throw coachingError(
      400,
      "invalid_assignment_target",
      `requiredGames must be an integer from 1 to ${ASSIGNMENT_MAX_REQUIRED_GAMES}.`,
    );
  }
  const recurrence = typeof input.recurrence === "string"
    ? input.recurrence.trim().toLowerCase()
    : "";
  if (!ASSIGNMENT_RECURRENCES.has(recurrence)) {
    throw coachingError(
      400,
      "invalid_assignment_recurrence",
      "recurrence must be once, daily, weekly, or monthly.",
    );
  }
  const timeZone = canonicalTimeZone(input.timeZone);
  if (!timeZone) {
    throw coachingError(400, "invalid_timezone", "Choose a valid IANA timezone.");
  }
  const start = parsePlainAssignmentDate(input.startsOn, "startsOn");
  const end = parsePlainAssignmentDate(input.endsOn, "endsOn");
  const startSerial = plainAssignmentDateSerial(start);
  const endSerial = plainAssignmentDateSerial(end);
  const days = Math.round((endSerial - startSerial) / 86400000) + 1;
  if (days < 1 || days > ASSIGNMENT_MAX_DAYS) {
    throw coachingError(
      400,
      "invalid_assignment_window",
      `The assignment window must be between 1 and ${ASSIGNMENT_MAX_DAYS} inclusive local dates.`,
    );
  }
  const endExclusive = addPlainAssignmentDays(end, 1);
  const startsAt = zonedLocalToUtc(start.year, start.month, start.day, 0, timeZone, true);
  const endsAt = zonedLocalToUtc(
    endExclusive.year,
    endExclusive.month,
    endExclusive.day,
    0,
    timeZone,
    true,
  );
  if (!startsAt || !endsAt || endsAt <= startsAt) {
    throw coachingError(400, "invalid_assignment_window", "Those local dates do not form a valid time window.");
  }

  let build = null;
  if (type === "build") {
    const rawBuild = input.build;
    if (!rawBuild || typeof rawBuild !== "object" || Array.isArray(rawBuild)) {
      throw coachingError(400, "invalid_assignment_build", "Choose a specific build for this assignment.");
    }
    const buildInput = /** @type {Record<string, unknown>} */ (rawBuild);
    const id = safeIdentity(buildInput.id);
    const name = safeIdentity(buildInput.name);
    const matchBy = buildInput.matchBy === "slug" || buildInput.matchBy === "name"
      ? buildInput.matchBy
      : null;
    if (!id || !name || !matchBy || id.length > 200 || name.length > 200) {
      throw coachingError(400, "invalid_assignment_build", "The assigned build needs a valid id and name.");
    }
    build = { id, name, matchBy };
  }

  const requirement = {
    type,
    requiredGames,
    build,
    recurrence,
    timeZone,
    startsOn: plainAssignmentDateString(start),
    endsOn: plainAssignmentDateString(end),
    startsAt,
    endsAt,
    title: optionalAssignmentText(input.title, 160, "title"),
    note: optionalAssignmentText(input.note, 1000, "note"),
  };
  // Validate every recurrence boundary before persistence. Some zones move
  // clocks at midnight; bucket expansion must never poison all future reads.
  assignmentBuckets(requirement);
  return requirement;
}

/** @param {unknown} value @param {string} field */
function parsePlainAssignmentDate(value, field) {
  const text = safeIdentity(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw coachingError(400, "invalid_assignment_window", `${field} must use YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const serial = new Date(Date.UTC(year, month - 1, day));
  if (
    serial.getUTCFullYear() !== year
    || serial.getUTCMonth() + 1 !== month
    || serial.getUTCDate() !== day
  ) {
    throw coachingError(400, "invalid_assignment_window", `${field} is not a valid calendar date.`);
  }
  return { year, month, day };
}

/** @param {{year:number,month:number,day:number}} value */
function plainAssignmentDateSerial(value) {
  return Date.UTC(value.year, value.month - 1, value.day);
}

/** @param {{year:number,month:number,day:number}} value @param {number} days */
function addPlainAssignmentDays(value, days) {
  const date = new Date(plainAssignmentDateSerial(value) + days * 86400000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** @param {{year:number,month:number,day:number}} value */
function plainAssignmentDateString(value) {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

/** @param {any} requirement */
function serializeGameRequirement(requirement) {
  return {
    type: requirement.type === "build" ? "build" : "total",
    requiredGames: nonNegativeInteger(requirement.requiredGames),
    build: requirement.type === "build" && requirement.build
      ? {
        id: safeIdentity(requirement.build.id),
        name: safeIdentity(requirement.build.name),
        matchBy: requirement.build.matchBy === "slug" ? "slug" : "name",
      }
      : null,
    recurrence: ASSIGNMENT_RECURRENCES.has(requirement.recurrence)
      ? requirement.recurrence
      : "once",
    timeZone: canonicalTimeZone(requirement.timeZone) || "UTC",
    title: typeof requirement.title === "string" ? requirement.title : null,
    note: typeof requirement.note === "string" ? requirement.note : null,
    window: {
      startsOn: safeIdentity(requirement.startsOn),
      endsOn: safeIdentity(requirement.endsOn),
      startsAt: assignmentDateIso(requirement.startsAt),
      endsAt: assignmentDateIso(requirement.endsAt),
      endExclusive: true,
    },
  };
}

/** @param {any} requirement */
function assignmentRequirementFingerprint(requirement) {
  return JSON.stringify({
    type: requirement.type === "build" ? "build" : "total",
    requiredGames: nonNegativeInteger(requirement.requiredGames),
    build: requirement.type === "build" && requirement.build
      ? {
        id: safeIdentity(requirement.build.id),
        name: safeIdentity(requirement.build.name),
        matchBy: requirement.build.matchBy === "slug" ? "slug" : "name",
      }
      : null,
    recurrence: ASSIGNMENT_RECURRENCES.has(requirement.recurrence)
      ? requirement.recurrence
      : "once",
    timeZone: canonicalTimeZone(requirement.timeZone) || "UTC",
    startsOn: safeIdentity(requirement.startsOn),
    endsOn: safeIdentity(requirement.endsOn),
    title: typeof requirement.title === "string" ? requirement.title : null,
    note: typeof requirement.note === "string" ? requirement.note : null,
  });
}

/** @param {unknown} value */
function assignmentDateIso(value) {
  const date = toDate(value);
  return date.getTime() > 0 ? date.toISOString() : null;
}

/** @param {any} requirement */
function assignmentBuckets(requirement) {
  const timeZone = canonicalTimeZone(requirement.timeZone) || "UTC";
  const start = parsePlainAssignmentDate(requirement.startsOn, "startsOn");
  const end = parsePlainAssignmentDate(requirement.endsOn, "endsOn");
  const endExclusive = addPlainAssignmentDays(end, 1);
  if (requirement.recurrence === "once") {
    return [{
      key: "once",
      startsAt: assignmentDateIso(requirement.startsAt),
      endsAt: assignmentDateIso(requirement.endsAt),
    }];
  }

  let cursor = start;
  let step = 1;
  if (requirement.recurrence === "weekly") {
    const day = new Date(plainAssignmentDateSerial(start)).getUTCDay();
    cursor = addPlainAssignmentDays(start, -((day + 6) % 7));
    step = 7;
  } else if (requirement.recurrence === "monthly") {
    cursor = { year: start.year, month: start.month, day: 1 };
  }
  const assignmentStart = toDate(requirement.startsAt);
  const assignmentEnd = toDate(requirement.endsAt);
  const out = [];
  while (plainAssignmentDateSerial(cursor) < plainAssignmentDateSerial(endExclusive)) {
    let next;
    let key;
    if (requirement.recurrence === "monthly") {
      next = cursor.month === 12
        ? { year: cursor.year + 1, month: 1, day: 1 }
        : { year: cursor.year, month: cursor.month + 1, day: 1 };
      key = plainAssignmentDateString(cursor).slice(0, 7);
    } else {
      next = addPlainAssignmentDays(cursor, step);
      key = plainAssignmentDateString(cursor);
    }
    const rawStart = zonedLocalToUtc(cursor.year, cursor.month, cursor.day, 0, timeZone, true);
    const rawEnd = zonedLocalToUtc(next.year, next.month, next.day, 0, timeZone, true);
    if (!rawStart || !rawEnd) {
      throw coachingError(500, "invalid_assignment_window", "Stored assignment dates could not be resolved.");
    }
    const startsAt = rawStart > assignmentStart ? rawStart : assignmentStart;
    const endsAt = rawEnd < assignmentEnd ? rawEnd : assignmentEnd;
    if (startsAt < endsAt) {
      out.push({ key, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() });
    }
    cursor = next;
  }
  return out;
}

/** @param {any} requirement */
function assignmentGroupExpression(requirement) {
  if (requirement.recurrence === "once") return null;
  const unit = requirement.recurrence === "daily"
    ? "day" : requirement.recurrence === "weekly" ? "week" : "month";
  return {
    $dateTrunc: {
      date: assignmentGameStartExpression(),
      unit,
      timezone: canonicalTimeZone(requirement.timeZone) || "UTC",
      ...(unit === "week" ? { startOfWeek: "monday" } : {}),
    },
  };
}

/** @param {any} requirement @param {any[]} rows */
function assignmentCountsByBucket(requirement, rows) {
  const counts = new Map();
  if (requirement.recurrence === "once") {
    counts.set("once", nonNegativeInteger(rows[0] && rows[0].playedGames));
    return counts;
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = toDate(row && row._id);
    if (date.getTime() <= 0) continue;
    const parts = zonedParts(date, canonicalTimeZone(requirement.timeZone) || "UTC");
    const local = plainAssignmentDateString(parts);
    const key = requirement.recurrence === "monthly" ? local.slice(0, 7) : local;
    counts.set(key, nonNegativeInteger(row.playedGames));
  }
  return counts;
}

/** @param {any} assignment */
function assignmentGameMatch(assignment) {
  const requirement = assignment.requirement || {};
  const bounds = assignmentEffectiveBounds(assignment);
  /** @type {Record<string, any>} */
  const startExpression = assignmentGameStartExpression();
  /** @type {Record<string, any>[]} */
  const clauses = [
    oneVsOneGameClause(),
    {
      $expr: {
        $and: [
          { $gte: [startExpression, bounds.startsAt] },
          { $lt: [startExpression, bounds.endsAt] },
        ],
      },
    },
  ];
  if (requirement.type === "build" && requirement.build) {
    const name = safeIdentity(requirement.build.name);
    const id = safeIdentity(requirement.build.id);
    clauses.push(requirement.build.matchBy === "slug" && id
      ? { _customBuildSlug: id }
      : name ? { myBuild: name } : { _id: null });
  }
  return {
    userId: assignment.studentUserId,
    isResumedFromReplay: { $ne: true },
    // Preserve an indexable coarse bound around the exact start-time
    // expression. A replay can last at most 24 hours by schema.
    date: {
      $gte: bounds.startsAt,
      $lt: new Date(bounds.endsAt.getTime() + 86_400_000),
    },
    $and: clauses,
  };
}

function assignmentGameStartExpression() {
  const exactStart = {
    $convert: { input: "$startedAt", to: "date", onError: null, onNull: null },
  };
  const end = {
    $convert: { input: "$date", to: "date", onError: null, onNull: null },
  };
  const duration = {
    $convert: { input: "$durationSec", to: "int", onError: null, onNull: null },
  };
  return {
    $ifNull: [
      exactStart,
      {
        $cond: [
          {
            $and: [
              { $ne: [end, null] },
              { $ne: [duration, null] },
              { $gte: [duration, 0] },
              { $lte: [duration, 86_400] },
            ],
          },
          { $dateSubtract: { startDate: end, unit: "second", amount: duration } },
          end,
        ],
      },
    ],
  };
}

function oneVsOneGameClause() {
  return {
    $or: [
      { matchFormat: "1v1" },
      { matchFormat: { $exists: false }, playerCount: 2 },
    ],
  };
}

/** @param {any} assignment */
function assignmentEffectiveBounds(assignment) {
  const requirement = assignment.requirement || {};
  const requirementStart = toDate(requirement.startsAt);
  const createdAt = toDate(assignment.createdAt);
  const startsAt = createdAt.getTime() > requirementStart.getTime()
    ? createdAt
    : requirementStart;
  const requirementEnd = toDate(requirement.endsAt);
  const cancelledAt = assignment.status === "cancelled"
    ? toDate(assignment.cancelledAt)
    : null;
  const endsAt = cancelledAt && cancelledAt.getTime() > 0 && cancelledAt < requirementEnd
    ? cancelledAt
    : requirementEnd;
  return { startsAt, endsAt };
}

function assignmentGameProjection() {
  return {
    _id: 1,
    gameId: 1,
    date: 1,
    startedAt: 1,
    durationSec: 1,
    map: 1,
    result: 1,
    myBuild: 1,
    isLadderGame: 1,
    matchFormat: 1,
    playerCount: 1,
    "opponent.displayName": 1,
    "replayFile.storedAt": 1,
  };
}

/** @param {string} assignmentId @param {any} game */
function serializeAssignmentGame(assignmentId, game) {
  const replayAvailable = Boolean(game && game.replayFile && game.replayFile.storedAt);
  const gameId = safeIdentity(game && game.gameId);
  return {
    gameId,
    date: assignmentDateIso(assignmentGameStartDate(game)),
    map: safeIdentity(game && game.map),
    opponent: safeAssignmentName(game && game.opponent && game.opponent.displayName, "Unknown opponent"),
    result: assignmentGameResult(game && game.result),
    myBuild: safeIdentity(game && game.myBuild) || null,
    isLadderGame: typeof (game && game.isLadderGame) === "boolean"
      ? game.isLadderGame
      : null,
    matchFormat: game && game.matchFormat === "1v1"
      ? "1v1"
      : (!game?.matchFormat && Number(game?.playerCount) === 2 ? "1v1" : "unknown"),
    replayAvailable,
    replayDownloadPath: replayAvailable
      ? `/v1/coaching/assignments/${encodeURIComponent(assignmentId)}/games/${encodeURIComponent(gameId)}/replay-download`
      : null,
  };
}

/** @param {any} game */
function assignmentGameStartDate(game) {
  const exact = toDate(game && game.startedAt);
  if (exact.getTime() > 0) return exact;
  const end = toDate(game && game.date);
  const duration = Number(game && game.durationSec);
  if (end.getTime() > 0 && Number.isFinite(duration) && duration >= 0 && duration <= 86_400) {
    return new Date(end.getTime() - Math.floor(duration) * 1000);
  }
  return end;
}

/** @param {unknown} value */
function assignmentGameResult(value) {
  const normalized = safeIdentity(value).toLowerCase();
  if (normalized === "victory" || normalized === "win") return "Win";
  if (normalized === "defeat" || normalized === "loss") return "Loss";
  if (normalized === "tie") return "Tie";
  return "Unknown";
}

/** @param {string} coachId */
function calendarId(coachId) {
  return `${CALENDAR_PREFIX}${coachId}`;
}

/** @param {unknown} value */
function normalizeAvailability(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coachingError(400, "invalid_availability", "Availability is required.");
  }
  const input = /** @type {Record<string,any>} */ (value);
  const timeZone = canonicalTimeZone(input.timeZone);
  if (!timeZone) {
    throw coachingError(400, "invalid_timezone", "Choose a valid IANA timezone.");
  }
  const durations = Array.from(new Set(
    (Array.isArray(input.durations) ? input.durations : []).map(Number),
  )).filter((n) =>
    Number.isInteger(n) &&
    n >= MIN_DURATION_MINUTES &&
    n <= MAX_DURATION_MINUTES &&
    n % SLOT_STEP_MINUTES === 0,
  ).sort((a, b) => a - b);
  if (durations.length === 0) {
    throw coachingError(400, "invalid_duration", "Offer at least one session length from 30 minutes to 8 hours.");
  }
  const rawWindows = Array.isArray(input.windows) ? input.windows : [];
  /** @type {Array<{day:number,startMinute:number,endMinute:number}>} */
  const windows = [];
  for (const raw of rawWindows) {
    const day = Number(raw && raw.day);
    const startMinute = parseClock(raw && (raw.startMinute ?? raw.start));
    const endMinute = parseClock(raw && (raw.endMinute ?? raw.end));
    if (!Number.isInteger(day) || day < 0 || day > 6 || startMinute === null || endMinute === null || endMinute <= startMinute) {
      throw coachingError(400, "invalid_window", "Every availability window needs a valid day, start time, and later end time.");
    }
    if (startMinute % SLOT_STEP_MINUTES !== 0 || endMinute % SLOT_STEP_MINUTES !== 0) {
      throw coachingError(400, "invalid_window", "Availability times must use 30-minute increments.");
    }
    windows.push({ day, startMinute, endMinute });
  }
  if (windows.length === 0) {
    throw coachingError(400, "invalid_window", "Add at least one available time window.");
  }
  windows.sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
  for (let day = 0; day < 7; day += 1) {
    const sameDay = windows.filter((w) => w.day === day);
    if (sameDay.length > MAX_WINDOWS_PER_DAY) {
      throw coachingError(400, "too_many_windows", `Use no more than ${MAX_WINDOWS_PER_DAY} windows per day.`);
    }
    for (let i = 1; i < sameDay.length; i += 1) {
      if (sameDay[i].startMinute < sameDay[i - 1].endMinute) {
        throw coachingError(400, "overlapping_windows", "Availability windows on the same day cannot overlap.");
      }
    }
  }
  return { timeZone, durations, windows };
}

/** @param {unknown} value @returns {number|null} */
function parseClock(value) {
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 24 * 60) {
    return Number(value);
  }
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (hours < 0 || hours > 24 || minutes < 0 || minutes > 59 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/** @param {unknown} value */
function canonicalTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function validTimeZone(value) {
  return Boolean(canonicalTimeZone(value));
}

/**
 * Expand recurring local wall-clock windows into concrete UTC slots. UTC is
 * the transport/storage format; clients render these instants in their own
 * local timezone.
 *
 * @param {{timeZone:string,durations:number[],windows:Array<{day:number,startMinute:number,endMinute:number}>}} availability
 * @param {any[]} bookings
 * @param {Date} from
 */
function buildAvailableSlots(availability, bookings, from) {
  if (!availability || !validTimeZone(availability.timeZone)) return [];
  const active = (Array.isArray(bookings) ? bookings : [])
    .filter((b) => b && b.status === "booked")
    .map((b) => ({ startAt: toDate(b.startAt), endAt: toDate(b.endAt) }));
  const today = zonedParts(from, availability.timeZone);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  /** @type {Array<{startAt:string,endAt:string,durationMinutes:number}>} */
  const slots = [];
  for (let offset = 0; offset < SLOT_HORIZON_DAYS; offset += 1) {
    const plain = new Date(base + offset * 86400000);
    const day = plain.getUTCDay();
    const windows = availability.windows.filter((window) => window.day === day);
    for (const window of windows) {
      // Resolve each local start only once, then test every offered duration
      // against it. Intl timezone conversion is the expensive part.
      for (let minute = window.startMinute; minute < window.endMinute; minute += SLOT_STEP_MINUTES) {
        const start = zonedLocalToUtc(
          plain.getUTCFullYear(),
          plain.getUTCMonth() + 1,
          plain.getUTCDate(),
          minute,
          availability.timeZone,
        );
        if (!start || start.getTime() <= from.getTime()) continue;
        for (const durationMinutes of availability.durations) {
          if (minute + durationMinutes > window.endMinute) continue;
          const end = new Date(start.getTime() + durationMinutes * 60000);
          // Do not offer sessions whose elapsed duration crosses a daylight-
          // saving jump/repeat. Their displayed local end would fall outside
          // the published wall-clock window or even appear earlier than the
          // start. Slots before and after the transition remain available.
          const expectedEnd = new Date(
            Date.UTC(
              plain.getUTCFullYear(),
              plain.getUTCMonth(),
              plain.getUTCDate(),
            ) + (minute + durationMinutes) * 60000,
          );
          const observedEnd = zonedParts(end, availability.timeZone);
          if (
            observedEnd.year !== expectedEnd.getUTCFullYear() ||
            observedEnd.month !== expectedEnd.getUTCMonth() + 1 ||
            observedEnd.day !== expectedEnd.getUTCDate() ||
            observedEnd.hour !== expectedEnd.getUTCHours() ||
            observedEnd.minute !== expectedEnd.getUTCMinutes()
          ) continue;
          if (active.some((b) => overlaps(start, end, b.startAt, b.endAt))) continue;
          slots.push({
            startAt: start.toISOString(),
            endAt: end.toISOString(),
            durationMinutes,
          });
        }
      }
    }
  }
  return slots.sort((a, b) =>
    a.startAt.localeCompare(b.startAt) || a.durationMinutes - b.durationMinutes,
  );
}

/** @param {Date} value @param {string} timeZone */
function zonedParts(value, timeZone) {
  let formatter = ZONE_PART_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    ZONE_PART_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  /** @type {Record<string,number>} */
  const out = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return /** @type {{year:number,month:number,day:number,hour:number,minute:number,second:number}} */ (out);
}

/**
 * Convert an IANA-zone local wall-clock value to UTC without a date library.
 * Two offset passes handle DST boundaries; a final round-trip rejects local
 * times that do not exist during a spring-forward transition.
 */
/**
 * @param {number} year @param {number} month @param {number} day
 * @param {number} minuteOfDay @param {string} timeZone
 * @param {boolean} [nextValidOnDate]
 */
function zonedLocalToUtc(year, month, day, minuteOfDay, timeZone, nextValidOnDate = false) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(wall);
  for (let i = 0; i < 3; i += 1) {
    const seen = zonedParts(candidate, timeZone);
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second || 0);
    const delta = wall - seenWall;
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  const roundTrip = zonedParts(candidate, timeZone);
  if (
    nextValidOnDate
    && roundTrip.year === year
    && roundTrip.month === month
    && roundTrip.day === day
    && roundTrip.hour * 60 + roundTrip.minute > minuteOfDay
  ) return candidate;
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    return null;
  }
  return candidate;
}

/**
 * Account ids whose Locker relationship identity is added, removed, or
 * rebound by a full-state write. Ordinary worksheet/note edits rely on the
 * Locker revision CAS; relationship edits additionally join the affected
 * accounts' GDPR/coaching mutation barrier so a stale client cannot recreate
 * an identity that a concurrent deletion has already scrubbed.
 * @param {Record<string, any>} previous @param {Record<string, any>} next
 */
function changedCoachingAccountIds(previous, next) {
  const beforeCoaches = new Map(
    (Array.isArray(previous.coaches) ? previous.coaches : [])
      .filter((coach) => coach && coach.id)
      .map((coach) => [coach.id, coach]),
  );
  const afterCoaches = new Map(
    (Array.isArray(next.coaches) ? next.coaches : [])
      .filter((coach) => coach && coach.id)
      .map((coach) => [coach.id, coach]),
  );
  const beforeStudents = new Map(
    (Array.isArray(previous.students) ? previous.students : [])
      .filter((student) => student && student.id)
      .map((student) => [student.id, student]),
  );
  const afterStudents = new Map(
    (Array.isArray(next.students) ? next.students : [])
      .filter((student) => student && student.id)
      .map((student) => [student.id, student]),
  );
  const changed = new Set();
  /** @param {unknown} value */
  const add = (value) => {
    const id = safeIdentity(value);
    if (id) changed.add(id);
  };
  /** @param {any} student @param {Map<any, any>} coaches */
  const addStudentAccounts = (student, coaches) => {
    if (!student) return;
    add(student.userId);
    add(student.practiceSharing?.studentUserId);
    add(student.practiceSharing?.coachUserId);
    add(coaches.get(student.coachId)?.userId);
  };

  for (const coachId of new Set([...beforeCoaches.keys(), ...afterCoaches.keys()])) {
    const before = beforeCoaches.get(coachId);
    const after = afterCoaches.get(coachId);
    if (safeIdentity(before?.userId) === safeIdentity(after?.userId)) continue;
    add(before?.userId);
    add(after?.userId);
  }
  for (const studentId of new Set([...beforeStudents.keys(), ...afterStudents.keys()])) {
    const before = beforeStudents.get(studentId);
    const after = afterStudents.get(studentId);
    const beforeIdentity = JSON.stringify([
      safeIdentity(before?.userId),
      safeIdentity(before?.coachId),
      safeIdentity(before?.practiceSharing?.studentUserId),
      safeIdentity(before?.practiceSharing?.coachUserId),
    ]);
    const afterIdentity = JSON.stringify([
      safeIdentity(after?.userId),
      safeIdentity(after?.coachId),
      safeIdentity(after?.practiceSharing?.studentUserId),
      safeIdentity(after?.practiceSharing?.coachUserId),
    ]);
    if (beforeIdentity === afterIdentity) continue;
    addStudentAccounts(before, beforeCoaches);
    addStudentAccounts(after, afterCoaches);
  }
  return Array.from(changed);
}

/** @param {any} doc @param {any} actor @param {Date} now */
function visibleBookings(doc, actor, now) {
  if (!doc || !Array.isArray(doc.bookings)) return [];
  const floor = now.getTime() - 30 * 86400000;
  return /** @type {any[]} */ (doc.bookings)
    .filter((b) => b && (actor.kind === "coach" || b.studentUserId === actor.student.userId))
    .filter((b) => toDate(b.endAt).getTime() >= floor)
    .sort((a, b) => toDate(a.startAt).getTime() - toDate(b.startAt).getTime());
}

/**
 * Group removed/reassigned student IDs by their previous coach calendar.
 * @param {Record<string, any>} previous @param {Record<string, any>} next
 */
function changedRosterStudents(previous, next) {
  const before = Array.isArray(previous.students) ? previous.students : [];
  const afterById = new Map(
    (Array.isArray(next.students) ? next.students : [])
      .filter(Boolean)
      .map((student) => [student.id, student]),
  );
  /** @type {Map<string, Set<string>>} */
  const changedByCoach = new Map();
  for (const student of before) {
    if (!student || !student.id || !student.coachId) continue;
    const after = afterById.get(student.id);
    if (after && after.coachId === student.coachId && after.userId === student.userId) continue;
    if (!changedByCoach.has(student.coachId)) changedByCoach.set(student.coachId, new Set());
    const changedStudents = changedByCoach.get(student.coachId);
    if (changedStudents) changedStudents.add(student.id);
  }
  return changedByCoach;
}

/** @param {any} doc @param {any} actor @param {string} userId */
function unreadBookings(doc, actor, userId) {
  if (!doc || !Array.isArray(doc.bookings)) return [];
  const field = actor.kind === "coach" ? "coachReadAt" : "studentReadAt";
  return /** @type {any[]} */ (doc.bookings)
    .filter((b) => b && b[field] == null && (actor.kind === "coach" || b.studentUserId === userId))
    .sort((a, b) => toDate(b.updatedAt || b.createdAt).getTime() - toDate(a.updatedAt || a.createdAt).getTime());
}

/**
 * Treat a retry of the same student's already-committed slot as success. This
 * makes booking safe when the first HTTP response is lost after Mongo commits.
 * @param {any} bookings @param {string} userId @param {Date} startAt @param {number} durationMinutes
 */
function findMatchingBooking(bookings, userId, startAt, durationMinutes) {
  if (!Array.isArray(bookings)) return null;
  return bookings.find((booking) =>
    booking &&
    booking.status === "booked" &&
    booking.studentUserId === userId &&
    booking.durationMinutes === durationMinutes &&
    toDate(booking.startAt).getTime() === startAt.getTime(),
  ) || null;
}

/** @param {any} value @param {any} updatedAt */
function publicAvailability(value, updatedAt, enabled = true) {
  return {
    enabled,
    timeZone: value.timeZone,
    durations: Array.isArray(value.durations) ? value.durations.slice() : [],
    windows: Array.isArray(value.windows)
      ? /** @type {any[]} */ (value.windows).map((w) => ({ day: w.day, startMinute: w.startMinute, endMinute: w.endMinute }))
      : [],
    updatedAt: updatedAt ? toDate(updatedAt).toISOString() : null,
  };
}

/** @param {any} value */
function publicBooking(value) {
  return {
    id: value.id,
    studentName: value.studentName || "Student",
    startAt: toDate(value.startAt).toISOString(),
    endAt: toDate(value.endAt).toISOString(),
    durationMinutes: value.durationMinutes,
    status: value.status === "cancelled" ? "cancelled" : "booked",
    cancelledBy: value.cancelledBy || null,
    createdAt: toDate(value.createdAt).toISOString(),
  };
}

/** @param {any} booking @param {string} kind */
function publicAlert(booking, kind) {
  const cancelled = booking.status === "cancelled";
  return {
    kind: cancelled ? "cancelled" : "booked",
    title: cancelled
      ? "Coaching session cancelled"
      : kind === "coach" ? "New coaching booking" : "Coaching session confirmed",
    message: kind === "coach"
      ? `${booking.studentName || "A student"} ${cancelled ? "cancelled" : "booked"} a session.`
      : `Your coach ${cancelled ? "cancelled" : "updated"} a session.`,
    startAt: toDate(booking.startAt).toISOString(),
  };
}

/** @param {unknown} value @returns {Date|null} */
function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {unknown} value @returns {Date} */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(/** @type {any} */ (value));
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

/** @param {Date} aStart @param {Date} aEnd @param {Date} bStart @param {Date} bEnd */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** @param {number} status @param {string} code @param {string} message */
function coachingError(status, code, message) {
  const error = /** @type {Error & {status:number,code:string}} */ (new Error(message));
  error.status = status;
  error.code = code;
  return error;
}

/** @returns {Record<string, any>} */
function emptyState() {
  return {
    v: 1, setup: false, pin: null, coach: "ReSpOnSe",
    coaches: [], students: [], assets: {}, customBuilds: [],
    wsTemplates: [], shelfLibrary: [],
  };
}

/**
 * @param {Record<string, any>} state
 * @param {number} rev
 * @returns {{coaches:any[],students:any[],rev:number}}
 */
function rosterFromState(state, rev) {
  return {
    coaches: Array.isArray(state.coaches) ? state.coaches : [],
    students: Array.isArray(state.students) ? state.students : [],
    rev,
  };
}

/** @param {unknown} d @returns {string} */
function toDay(d) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  if (typeof d === "string" && d.length >= 10) return d.slice(0, 10);
  return "";
}

/** @param {string} s @returns {string} */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COACHING_MATCHUP_ORDER = new Map([
  ["PvP", 0], ["PvT", 1], ["PvZ", 2],
  ["ZvP", 3], ["ZvT", 4], ["ZvZ", 5],
  ["TvP", 6], ["TvT", 7], ["TvZ", 8],
]);

/** @returns {Record<string, any>} */
function coachingResultExpr() {
  return {
    $switch: {
      branches: [
        {
          case: {
            $in: [
              { $toLower: { $ifNull: ["$result", ""] } },
              ["victory", "win"],
            ],
          },
          then: "win",
        },
        {
          case: {
            $in: [
              { $toLower: { $ifNull: ["$result", ""] } },
              ["defeat", "loss"],
            ],
          },
          then: "loss",
        },
      ],
      default: "other",
    },
  };
}

/** @param {string} field @returns {Record<string, any>} */
function coachingRaceExpr(field) {
  const firstLetter = {
    $toUpper: {
      $substrCP: [
        {
          $convert: {
            input: field,
            to: "string",
            onError: "",
            onNull: "",
          },
        },
        0,
        1,
      ],
    },
  };
  return {
    $switch: {
      branches: [
        { case: { $eq: [firstLetter, "P"] }, then: "P" },
        { case: { $eq: [firstLetter, "T"] }, then: "T" },
        { case: { $eq: [firstLetter, "Z"] }, then: "Z" },
      ],
      default: "U",
    },
  };
}

/** @param {unknown} value @returns {number} */
function nonNegativeInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function boundedPositiveInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

/** @param {unknown} value @returns {"P"|"T"|"Z"|"U"} */
function coachingRaceLetter(value) {
  const letter = String(value || "").trim().slice(0, 1).toUpperCase();
  return letter === "P" || letter === "T" || letter === "Z" ? letter : "U";
}

/** @param {string} matchup @returns {number} */
function coachingMatchupOrder(matchup) {
  return COACHING_MATCHUP_ORDER.get(matchup) ?? Number.MAX_SAFE_INTEGER;
}

/** @param {ConstructorParameters<typeof CoachingService>[0]} deps */
function buildCoachingService(deps) {
  return new CoachingService(deps);
}

module.exports = {
  buildCoachingService,
  CoachingService,
  buildAvailableSlots,
  normalizeAvailability,
  zonedLocalToUtc,
};
