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
   * }, io?: import('socket.io').Server|null, logger?: import('pino').Logger}} deps
   */
  constructor(deps) {
    this.db = deps.db;
    this.io = deps.io || null;
    this.logger = deps.logger || null;
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
   * @returns {Promise<{ok: true, rev: number}|{ok: false, rev: number, state: Record<string, any>}>}
   */
  async putState(state, expectedRev) {
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
  }

  /**
   * Fence calendars before a roster removal/reassignment. The lock and
   * rosterRev increment happen atomically on each affected calendar:
   * in-flight bookings either win first (and block the roster edit) or see a
   * lock/revision mismatch and fail. This closes the cross-document race
   * without requiring every deployment to support Mongo transactions.
   * @param {Record<string, any>} state
   * @param {number} expectedRev
   */
  async putStateWithRosterGuard(state, expectedRev) {
    const current = await this.getDoc();
    if (current.rev !== expectedRev) {
      return { ok: false, rev: current.rev, state: current.state };
    }
    const changes = changedRosterStudents(current.state, state);
    if (changes.size === 0) return this.putState(state, expectedRev);

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
      return await this.putState(state, expectedRev);
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
        const result = await this.putState(nextState, current.rev);
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
   *   res: string, b: string}>>}
   */
  async gamesFor(userId) {
    const rows = await this.db.games
      .find(
        { userId, isResumedFromReplay: { $ne: true } },
        {
          projection: {
            _id: 0, date: 1, map: 1, opponent: 1, result: 1, myBuild: 1,
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
    const zone = validTimeZone(viewerTimeZone)
      ? String(viewerTimeZone)
      : "UTC";
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
      result = await this.db.coaching.updateOne(
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
    const result = await this.db.coaching.updateOne(
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
    const result = await this.db.coaching.updateOne(
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
    const result = await this.db.coaching.updateOne(
      filter,
      { $set: set, $inc: { calendarRev: 1 } },
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
    await this.db.coaching.updateOne(
      /** @type {any} */ ({ _id: calendarId(actor.coach.id) }),
      {
        $set: {
          [`bookings.$[booking].${field}`]: at,
          updatedAt: at,
        },
      },
      { arrayFilters: [bookingFilter] },
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
  const timeZone = typeof input.timeZone === "string" ? input.timeZone.trim() : "";
  if (!validTimeZone(timeZone)) {
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
function validTimeZone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
 */
function zonedLocalToUtc(year, month, day, minuteOfDay, timeZone) {
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
  if (roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day || roundTrip.hour !== hour || roundTrip.minute !== minute) {
    return null;
  }
  return candidate;
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
