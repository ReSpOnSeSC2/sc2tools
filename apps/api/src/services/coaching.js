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

const DOC_ID = "locker";
const USERS_PAGE = 20;
const GAMES_CAP = 500;

class CoachingService {
  /**
   * @param {{db: {
   *   coaching: import('mongodb').Collection,
   *   users: import('mongodb').Collection,
   *   games: import('mongodb').Collection,
   *   devicePairings: import('mongodb').Collection,
   * }}} deps
   */
  constructor(deps) {
    this.db = deps.db;
  }

  /** @returns {Promise<{state: Record<string, any>, rev: number}>} */
  async getDoc() {
    const doc = await this.db.coaching.findOne(/** @type {any} */ ({ _id: DOC_ID }));
    if (!doc) return { state: emptyState(), rev: 0 };
    return { state: doc.state || emptyState(), rev: doc.rev || 0 };
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
    const res = await this.db.coaching.updateOne(
      /** @type {any} */ (expectedRev
        ? { _id: DOC_ID, rev: expectedRev }
        : { _id: DOC_ID, rev: { $in: [0, null] } }),
      {
        $set: { state, rev: next, updatedAt: new Date() },
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
   * Resolve the caller's coaching role from the state document.
   *
   * @param {string} userId  internal user UUID (req.auth.userId)
   * @param {boolean} platformAdmin
   * @returns {Promise<{role: 'admin'|'coach'|'student'|'none',
   *   coachId?: string, studentId?: string, rev: number}>}
   */
  async roleFor(userId, platformAdmin) {
    const { state, rev } = await this.getDoc();
    const coaches = Array.isArray(state.coaches) ? state.coaches : [];
    const students = Array.isArray(state.students) ? state.students : [];
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
      .limit(USERS_PAGE)
      .toArray();
    const ids = rows.map((r) => r.userId).filter(Boolean);
    /** @type {Map<string, Date|null>} */
    const agentSeen = new Map();
    if (ids.length > 0) {
      const pairings = await this.db.devicePairings
        .find(
          { userId: { $in: ids }, revokedAt: { $in: [null, undefined] } },
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
    return rows.map((r) => ({
      userId: r.userId,
      clerkUserId: r.clerkUserId || null,
      email: r.email,
      hasAgent: agentSeen.has(r.userId),
      agentLastSeen: (() => {
        const d = agentSeen.get(r.userId);
        return d instanceof Date ? d.toISOString() : null;
      })(),
    }));
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
}

/** @returns {Record<string, any>} */
function emptyState() {
  return {
    v: 1, setup: false, pin: null, coach: "ReSpOnSe",
    coaches: [], students: [], assets: {}, customBuilds: [],
    wsTemplates: [], shelfLibrary: [],
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

/** @param {ConstructorParameters<typeof CoachingService>[0]} deps */
function buildCoachingService(deps) {
  return new CoachingService(deps);
}

module.exports = { buildCoachingService, CoachingService };
