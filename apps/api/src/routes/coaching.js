"use strict";

const express = require("express");
const { parseFilters } = require("../util/parseQuery");

// Whole-state payloads carry embedded media (voice memos, images,
// small replays) as base64. Body parsing is owned by the app-level
// parser: isCoachingStateJson() in app.js grants PUT /coaching/state
// its 16mb ceiling (behind pre-parse auth); everything else stays on
// the small default.

/**
 * /v1/coaching — the Coaching Locker's backend.
 *
 * Quiet by design: every endpoint requires auth, and everything except
 * ``GET /coaching/me`` additionally requires a coaching role. Accounts
 * with no role get 404s, so the feature is invisible to the wider
 * user base.
 *
 *   GET  /coaching/me                      — role + linkage for the signed-in user
 *   GET  /coaching/state                   — full state (admin/coach) or scoped (student)
 *   PUT  /coaching/state                   — CAS write {state, rev} (admin/coach)
 *   GET  /coaching/users?q=                — signed-up directory + live agent check (admin/coach)
 *   GET  /coaching/practice-sharing        — live student-approved assignment/replay consent
 *   POST /coaching/students/:id/practice-sharing/request — coach requests or re-requests consent
 *   POST /coaching/practice-sharing/respond — student accepts/rejects a pending relationship
 *   POST /coaching/practice-sharing/revoke  — student revokes an accepted relationship
 *   GET  /coaching/assignments             — role-scoped requirements + live replay progress
 *   POST /coaching/students/:id/assignments — create an idempotent practice requirement
 *   PUT  /coaching/assignments/:id         — CAS-update or cancel a requirement
 *   GET  /coaching/assignments/:id/games   — paged replay evidence
 *   GET  /coaching/assignments/:id/games/:gameId/replay-download — authorized replay
 *   GET  /coaching/students/:studentId/performance — consent-gated ranked replay performance
 *   GET  /coaching/students/:userId/games  — consent-gated slim 1v1 list for build suggestions
 *   GET  /coaching/calendar                — availability, bookings, and student-local slot instants
 *   PUT  /coaching/calendar/availability   — publish recurring coach hours
 *   POST /coaching/calendar/bookings       — atomically book an attached coach
 *   POST /coaching/calendar/bookings/:id/cancel — cancel an owned booking
 *   GET  /coaching/alerts                  — private global-header unread probe
 *   POST /coaching/alerts/read             — mark caller's coaching alerts read
 *
 * @param {{
 *   auth: import('express').RequestHandler,
 *   isAdmin: (req: import('express').Request) => boolean,
 *   coaching: import('../services/coaching').CoachingService,
 *   aggregations: import('../services/types').AggregationsService,
 *   replayFiles?: import('../services/replayFiles').ReplayFilesService|null,
 *   users: {getSummary(userId: string): Promise<{userId: string, clerkUserId: string|null, email: string|null}>},
 *   logger?: import('pino').Logger,
 * }} deps
 */
function buildCoachingRouter(deps) {
  const router = express.Router();
  // Path-scoped on purpose: this router mounts at the shared /v1
  // prefix, so a bare router.use() would run for every /v1 request
  // passing through on its way to routers mounted later — 401ing the
  // public routes (community, ladder meta, chatbot, ...) downstream.
  router.use("/coaching", auth());

  function auth() {
    return deps.auth;
  }

  /**
   * Resolve role once per request.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  async function withRole(req, res, next) {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      req.coachingRole = await deps.coaching.roleFor(
        auth.userId,
        deps.isAdmin(req),
      );
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Auth + resolved role, non-optional — withRole always runs first.
   *
   * @param {import('express').Request} req
   * @returns {{auth: NonNullable<import('express').Request['auth']>,
   *   cr: NonNullable<import('express').Request['coachingRole']>}}
   */
  function ctx(req) {
    const auth = req.auth;
    const cr = req.coachingRole;
    if (!auth || !cr) throw new Error("auth_required");
    return { auth, cr };
  }

  router.get("/coaching/me", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      const me = await deps.users.getSummary(auth.userId);
      res.json({
        role: cr.role,
        coachId: cr.coachId || null,
        studentId: cr.studentId || null,
        userId: auth.userId,
        email: me.email,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/state", withRole, async (req, res, next) => {
    try {
      const { role, studentId, coachId } = ctx(req).cr;
      if (role === "none") { res.status(404).json({ error: "not_found" }); return; }
      const { state, rev } = await deps.coaching.getDoc();
      if (role === "student") {
        const students = /** @type {any[]} */ (state.students || []);
        const student = students.find((s) => s.id === studentId);
        res.json({
          rev,
          scoped: true,
          state: {
            coach: state.coach,
            coaches: /** @type {any[]} */ (state.coaches || []).map((c) => ({ id: c.id, name: c.name })),
            students: student ? [publicStudentState(student)] : [],
            customBuilds: state.customBuilds || [],
            assets: pickAssets(state, student),
          },
        });
        return;
      }
      if (role === "coach") {
        res.json({
          rev,
          scoped: true,
          state: scopeCoachState(state, coachId),
        });
        return;
      }
      res.json({ rev, scoped: false, state });
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/alerts", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      res.json(await deps.coaching.alertSummary(auth.userId, cr));
    } catch (err) {
      next(err);
    }
  });

  router.post("/coaching/alerts/read", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await deps.coaching.markAlertsRead(auth.userId, cr, req.body));
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/calendar", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const timeZone = typeof req.query.timeZone === "string"
        ? req.query.timeZone
        : undefined;
      res.json(await deps.coaching.calendarFor(auth.userId, cr, timeZone));
    } catch (err) {
      next(err);
    }
  });

  router.put("/coaching/calendar/availability", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await deps.coaching.saveAvailability(auth.userId, cr, req.body));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/coaching/calendar/availability", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(await deps.coaching.pauseAvailability(auth.userId, cr, req.body));
    } catch (err) {
      next(err);
    }
  });

  router.post("/coaching/calendar/bookings", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      if (cr.role === "none") {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const out = await deps.coaching.bookSession(auth.userId, cr, req.body || {});
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/coaching/calendar/bookings/:bookingId/cancel",
    withRole,
    async (req, res, next) => {
      try {
        const { auth, cr } = ctx(req);
        if (cr.role === "none") {
          res.status(404).json({ error: "not_found" });
          return;
        }
        res.json(await deps.coaching.cancelSession(
          auth.userId,
          cr,
          req.params.bookingId,
        ));
      } catch (err) {
        next(err);
      }
    },
  );

  router.put("/coaching/state", withRole, async (req, res, next) => {
    try {
      const { auth, cr } = ctx(req);
      const { role } = cr;
      // Students write too — worksheet answers, intake, submissions all
      // mutate state. Scoped-write safety for students is enforced by the
      // merge below; coaches/admin write the full document.
      if (role === "none") { res.status(404).json({ error: "not_found" }); return; }
      const body = req.body || {};
      const incoming = body.state;
      const rev = Number(body.rev) || 0;
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        res.status(400).json({ error: "bad_state" }); return;
      }
      let toWrite = incoming;
      const current = await deps.coaching.getDoc();
      if (role === "student") {
        toWrite = mergeStudentWrite(current.state, incoming, cr.studentId);
        if (!toWrite) { res.status(403).json({ error: "not_writer" }); return; }
      } else if (role === "coach") {
        toWrite = mergeCoachWrite(current.state, incoming, cr.coachId);
        if (!toWrite) { res.status(403).json({ error: "not_writer" }); return; }
      }
      const out = await deps.coaching.putStateWithRosterGuard(
        toWrite,
        rev,
        [auth.userId],
      );
      if (!out.ok) {
        res.status(409).json({ error: "conflict", rev: out.rev, state: out.state });
        return;
      }
      res.json({ ok: true, rev: out.rev });
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/users", withRole, async (req, res, next) => {
    try {
      const { role } = ctx(req).cr;
      if (role !== "admin" && role !== "coach") {
        res.status(404).json({ error: "not_found" }); return;
      }
      const q = typeof req.query.q === "string" ? req.query.q : "";
      res.json({ users: await deps.coaching.listUsers(q) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/practice-sharing", withRole, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    try {
      const { auth, cr } = ctx(req);
      if (auth.source !== "clerk") {
        coachingNotFound(res);
        return;
      }
      res.json(await deps.coaching.practiceSharingFor(auth.userId, cr));
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/coaching/students/:studentId/practice-sharing/request",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        res.json(await deps.coaching.requestPracticeSharing(
          auth.userId,
          cr,
          req.params.studentId,
          req.body || {},
        ));
      } catch (err) {
        next(err);
      }
    },
  );

  router.post("/coaching/practice-sharing/respond", withRole, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    try {
      const { auth, cr } = ctx(req);
      if (auth.source !== "clerk") {
        coachingNotFound(res);
        return;
      }
      res.json(await deps.coaching.respondPracticeSharing(
        auth.userId,
        cr,
        req.body || {},
      ));
    } catch (err) {
      next(err);
    }
  });

  router.post("/coaching/practice-sharing/revoke", withRole, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    try {
      const { auth, cr } = ctx(req);
      if (auth.source !== "clerk") {
        coachingNotFound(res);
        return;
      }
      res.json(await deps.coaching.revokePracticeSharing(
        auth.userId,
        cr,
        req.body || {},
      ));
    } catch (err) {
      next(err);
    }
  });

  router.get("/coaching/assignments", withRole, async (req, res, next) => {
    res.set("Cache-Control", "private, no-store, max-age=0");
    try {
      const { auth, cr } = ctx(req);
      if (auth.source !== "clerk") {
        coachingNotFound(res);
        return;
      }
      const studentId = typeof req.query.studentId === "string"
        ? req.query.studentId
        : undefined;
      const page = Number(req.query.page);
      const limit = Number(req.query.limit);
      const result = await deps.coaching.listAssignments(
        auth.userId,
        cr,
        { studentId, page, limit, paginated: true },
      );
      const pageResult = Array.isArray(result)
        ? {
          assignments: result,
          page: Number.isInteger(page) && page > 0 ? page : 1,
          limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20,
          hasMore: false,
        }
        : result;
      res.json({ serverTime: new Date().toISOString(), ...pageResult });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/coaching/students/:studentId/assignments",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        const assignment = await deps.coaching.createAssignment(
          auth.userId,
          cr,
          req.params.studentId,
          req.body || {},
        );
        res.status(201).json({ assignment });
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    "/coaching/assignments/:assignmentId",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        const assignment = await deps.coaching.replaceAssignment(
          auth.userId,
          cr,
          req.params.assignmentId,
          req.body || {},
        );
        res.json({ assignment });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/coaching/assignments/:assignmentId/games",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        res.json(await deps.coaching.assignmentGames(
          auth.userId,
          cr,
          req.params.assignmentId,
          { page: Number(req.query.page), limit: Number(req.query.limit) },
        ));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/coaching/assignments/:assignmentId/games/:gameId/replay-download",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        const owner = await deps.coaching.assignmentReplayOwner(
          auth.userId,
          cr,
          req.params.assignmentId,
          req.params.gameId,
        );
        if (!deps.replayFiles) {
          const unavailable = /** @type {Error & {status:number,code:string}} */ (
            new Error("Original replay storage is unavailable.")
          );
          unavailable.status = 503;
          unavailable.code = "replay_storage_unavailable";
          throw unavailable;
        }
        res.json(await deps.replayFiles.prepareDownload(owner.userId, owner.gameId));
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/coaching/students/:studentId/performance",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        // Device credentials are intended for replay ingestion and must never
        // become a bearer token for another player's analytics.
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }

        const roster = await deps.coaching.getRoster();
        const matchingStudents = (Array.isArray(roster.students)
          ? roster.students
          : [])
          .filter((student) => student && student.id === req.params.studentId);
        if (matchingStudents.length !== 1) {
          coachingNotFound(res);
          return;
        }
        const student = matchingStudents[0];
        const targetUserId = typeof student.userId === "string"
          ? student.userId.trim()
          : "";
        let allowed = cr.role === "admin"
          || (cr.role === "student"
            && cr.studentId === student.id
            && targetUserId === auth.userId);
        if (cr.role === "coach" && cr.coachId && student.coachId === cr.coachId) {
          const sharing = await deps.coaching.practiceSharingFor(auth.userId, cr);
          allowed = sharing.relationships.some((/** @type {any} */ relationship) =>
            relationship
            && relationship.student?.id === student.id
            && relationship.status === "accepted",
          );
        }
        if (!targetUserId || !allowed) {
          coachingNotFound(res);
          return;
        }

        const coach = (Array.isArray(roster.coaches) ? roster.coaches : [])
          .find((candidate) => candidate && candidate.id === student.coachId);
        const filters = {
          ...parseFilters(req.query),
          // This view is deliberately narrower than the global analytics
          // controls. Coaching decisions must not mix custom/team games into
          // the ranked 1v1 record, even if those query params are forged.
          mapPool: "ladder",
          gameSize: "1v1",
        };
        const interval = coachingInterval(req.query.interval);
        const tz = coachingTimeZone(req.query.tz);
        const [rawRecord, rawMmr, overallNet] = await Promise.all([
          deps.coaching.performanceRecord(targetUserId, filters),
          deps.aggregations.mmrProgression(
            targetUserId,
            { interval, tz },
            filters,
          ),
          // Opt-in exact matchup mode retains the canonical adjacency and
          // coverage facets while producing all P/T/Z × P/T/Z rows from the
          // same single window scan.
          deps.aggregations.netMmrByMatchup(targetUserId, filters, {
            tz,
            groupByOwnRace: true,
          }),
        ]);
        const record = sanitizeCoachingRecord(rawRecord);
        const netByMatchup = coachingNetByMatchup(overallNet);
        const matchups = record.matchups.map((row) => {
          const net = netByMatchup.get(row.matchup);
          return {
            matchup: row.matchup,
            myRace: row.myRace,
            opponentRace: row.opponentRace,
            games: row.games,
            wins: row.wins,
            losses: row.losses,
            winRate: row.winRate,
            netMmr: net ? net.netMmr : null,
            measuredGames: net ? net.measuredGames : 0,
            avgDelta: net ? net.avgDelta : null,
          };
        });

        res.json({
          student: {
            id: student.id,
            name: safeDisplayName(student.name, "Student"),
            coach: coach ? {
              id: coach.id,
              name: safeDisplayName(coach.name, "Coach"),
            } : null,
          },
          scope: {
            since: isoDateOrNull(filters.since),
            until: isoDateOrNull(filters.until),
            interval,
            tz,
          },
          summary: record.summary,
          matchups,
          mmr: sanitizeCoachingMmr(rawMmr, interval),
          dailySwings: sanitizeCoachingDailySwings(overallNet, tz),
          coverage: sanitizeCoachingNetCoverage(overallNet),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/coaching/students/:userId/games",
    withRole,
    async (req, res, next) => {
      res.set("Cache-Control", "private, no-store, max-age=0");
      try {
        const { auth, cr } = ctx(req);
        if (auth.source !== "clerk") {
          coachingNotFound(res);
          return;
        }
        const role = cr.role;
        const target = req.params.userId;
        const self = target === auth.userId;
        let allowed = role === "admin" || (role === "student" && self);
        if (role === "coach" && cr.coachId) {
          const roster = await deps.coaching.getRoster();
          const matchingStudents = roster.students.filter((student) =>
            student &&
            student.coachId === cr.coachId &&
            student.userId === target,
          );
          if (matchingStudents.length === 1) {
            const sharing = await deps.coaching.practiceSharingFor(auth.userId, cr);
            allowed = sharing.relationships.some((/** @type {any} */ relationship) =>
              relationship
              && relationship.student?.id === matchingStudents[0].id
              && relationship.status === "accepted",
            );
          }
        }
        if (!allowed) {
          res.status(404).json({ error: "not_found" }); return;
        }
        res.json({ games: await deps.coaching.gamesFor(target) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

/**
 * A student's write may only change THEIR OWN student record — and not
 * its coach assignment. Everything else comes from the server's copy.
 *
 * @param {Record<string, any>} serverState
 * @param {Record<string, any>} incoming
 * @param {string|undefined} studentId
 * @returns {Record<string, any>|null}
 */
function mergeStudentWrite(serverState, incoming, studentId) {
  if (!studentId) return null;
  const mineIncoming = /** @type {any[]} */ (incoming.students || []).find((s) => s && s.id === studentId);
  if (!mineIncoming) return null;
  const students = /** @type {any[]} */ (serverState.students || []).map((s) => {
    if (!s || s.id !== studentId) return s;
    return { ...mineIncoming, coachId: s.coachId, userId: s.userId };
  });
  // New assets referenced by the student's record (e.g. uploaded
  // replays) ride along; existing assets are never overwritten.
  const assets = { ...(incoming.assets || {}), ...(serverState.assets || {}) };
  return { ...serverState, students, assets };
}

/**
 * A coach receives only their roster and may only write those records. Stable
 * identity/assignment fields are preserved server-side; new students are
 * always attached to the caller and cannot duplicate an existing account.
 * @param {Record<string, any>} serverState
 * @param {Record<string, any>} incoming
 * @param {string|undefined} coachId
 */
function mergeCoachWrite(serverState, incoming, coachId) {
  if (!coachId) return null;
  const current = Array.isArray(serverState.students) ? serverState.students : [];
  const currentById = new Map(current.filter(Boolean).map((student) => [student.id, student]));
  const assignedUsers = new Set(current.map((student) => student && student.userId).filter(Boolean));
  const own = [];
  for (const candidate of Array.isArray(incoming.students) ? incoming.students : []) {
    if (!candidate || typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    const existing = currentById.get(candidate.id);
    if (existing) {
      if (existing.coachId !== coachId) continue;
      own.push({
        ...candidate,
        id: existing.id,
        userId: existing.userId,
        coachId: existing.coachId,
      });
      continue;
    }
    const userId = typeof candidate.userId === "string" ? candidate.userId : null;
    if (userId && assignedUsers.has(userId)) continue;
    if (userId) assignedUsers.add(userId);
    own.push({ ...candidate, coachId });
  }
  const others = current.filter((student) => student && student.coachId !== coachId);
  return {
    ...serverState,
    ...incoming,
    coaches: serverState.coaches || [],
    students: [...others, ...own],
    assets: { ...(incoming.assets || {}), ...(serverState.assets || {}) },
  };
}

/** @param {Record<string, any>} state @param {string|undefined} coachId */
function scopeCoachState(state, coachId) {
  const students = /** @type {any[]} */ (state.students || [])
    .filter((student) => student && student.coachId === coachId)
    .map(publicStudentState);
  return {
    ...state,
    coaches: /** @type {any[]} */ (state.coaches || [])
      .map((coach) => ({ id: coach.id, name: coach.name })),
    students,
    assets: pickAssetsForStudents(state, students),
  };
}

/**
 * Account-binding ids stay server-side. Scoped Locker clients only need the
 * student's decision and timestamps; dedicated consent mutations resolve the
 * live identities again before writing.
 * @param {any} student
 */
function publicStudentState(student) {
  if (!student || !student.practiceSharing || typeof student.practiceSharing !== "object") {
    return student;
  }
  const sharing = student.practiceSharing;
  return {
    ...student,
    practiceSharing: {
      version: 1,
      status: ["pending", "accepted", "rejected", "revoked"].includes(sharing.status)
        ? sharing.status
        : "pending",
      requestedAt: sharing.requestedAt || null,
      respondedAt: sharing.respondedAt || null,
      revokedAt: sharing.revokedAt || null,
    },
  };
}

/**
 * Only the assets a student's own view references — their shelf, their
 * builds' references, their submissions.
 *
 * @param {Record<string, any>} state
 * @param {any} student
 * @returns {Record<string, unknown>}
 */
function pickAssets(state, student) {
  if (!student) return {};
  const blob = JSON.stringify([
    student.shelf || [], student.builds || [], student.submissions || [],
    (state.customBuilds || []),
  ]);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [id, a] of Object.entries(state.assets || {})) {
    if (blob.includes(id)) out[id] = a;
  }
  return out;
}

/** @param {Record<string, any>} state @param {any[]} students */
function pickAssetsForStudents(state, students) {
  const blob = JSON.stringify([
    students,
    state.customBuilds || [],
    state.shelfLibrary || [],
    state.wsTemplates || [],
  ]);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [id, asset] of Object.entries(state.assets || {})) {
    if (blob.includes(id)) out[id] = asset;
  }
  return out;
}

const COACHING_MMR_COVERAGE_KEYS = [
  "filteredGames",
  "numericMmrGames",
  "verifiedReplayMmrGames",
  "untrustedNumericMmrGames",
  "unavailableMmrGames",
  "missingMmrGames",
  "excludedNonRanked1v1Games",
  "missingAccountGames",
  "missingLadderRaceGames",
  "eligibleGames",
];

const COACHING_NET_DROP_KEYS = [
  "excludedNonRanked1v1",
  "missingIdentity",
  "missingMyMmr",
  "untrustedMyMmr",
  "terminalGame",
  "nextMissingMyMmr",
  "nextUntrustedMyMmr",
  "outlierSwing",
  "signMismatch",
  "unsupportedResult",
];

const COACHING_MMR_SERIES_LIMIT = 12;

/** @param {import('express').Response} res */
function coachingNotFound(res) {
  res.status(404).json({ error: "not_found" });
}

/** @param {unknown} raw @returns {'day'|'week'|'month'} */
function coachingInterval(raw) {
  const value = String(raw || "day").toLowerCase();
  if (value === "week" || value === "month") return value;
  return "day";
}

/** @param {unknown} raw @returns {string} */
function coachingTimeZone(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "UTC";
  const value = raw.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

/**
 * Allowlist exact own-race/opponent-race net-MMR rows returned by the
 * canonical single-window aggregation. Only aggregate values leave this
 * boundary.
 * @param {unknown} raw
 * @returns {Map<string,{netMmr:number|null,measuredGames:number,avgDelta:number|null}>}
 */
function coachingNetByMatchup(raw) {
  const out = new Map();
  const root = asRecord(raw);
  const rows = Array.isArray(root.matchups) ? root.matchups : [];
  for (const rawRow of rows) {
    const row = asRecord(rawRow);
    const myRace = coachingRace(row.myRace, false);
    const opponentRace = coachingRace(row.opponentRace, false);
    if (!myRace || !opponentRace) continue;
    const measuredGames = nonNegativeCount(row.pairs ?? row.games);
    out.set(`${myRace}v${opponentRace}`, {
      netMmr: measuredGames > 0 ? finiteNumber(row.netMmr) : null,
      measuredGames,
      avgDelta: measuredGames > 0 ? finiteNumber(row.avgDelta) : null,
    });
  }
  return out;
}

/**
 * Reconcile the all-decided headline with the concrete nine-matchup matrix.
 * Unknown/missing race values remain visible as unclassified rather than
 * disappearing or diluting a matchup's win rate.
 * @param {unknown} raw
 */
function sanitizeCoachingRecord(raw) {
  const root = asRecord(raw);
  const rows = Array.isArray(root.matchups) ? root.matchups : [];
  const matchups = rows.map((value) => {
    const row = asRecord(value);
    const myRace = coachingRace(row.myRace, false);
    const opponentRace = coachingRace(row.opponentRace, false);
    if (!myRace || !opponentRace) return null;
    const wins = nonNegativeCount(row.wins);
    const losses = nonNegativeCount(row.losses);
    const games = wins + losses;
    return {
      matchup: `${myRace}v${opponentRace}`,
      myRace,
      opponentRace,
      games,
      wins,
      losses,
      winRate: games > 0 ? wins / games : 0,
    };
  }).filter((row) => row !== null);
  const summary = asRecord(root.summary);
  const wins = nonNegativeCount(summary.wins);
  const losses = nonNegativeCount(summary.losses);
  const games = wins + losses;
  const classifiedGames = Math.min(
    games,
    matchups.reduce((total, row) => total + row.games, 0),
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
    matchups,
  };
}

/**
 * The canonical MMR service necessarily partitions by Battle.net account.
 * This allowlist removes those identifiers and constructs non-identifying
 * labels from region + played race, adding only an ordinal when needed.
 * @param {unknown} raw
 * @param {'day'|'week'|'month'} requestedInterval
 */
function sanitizeCoachingMmr(raw, requestedInterval) {
  const root = asRecord(raw);
  const source = Array.isArray(root.series)
    ? root.series
    : Array.isArray(root.accounts) ? root.accounts : [];
  const prepared = source.slice(0, COACHING_MMR_SERIES_LIMIT).map((value) => {
    const row = asRecord(value);
    const region = coachingRegion(row.region);
    const ladderRace = coachingRace(row.ladderRace, true) || "U";
    return { row, region, ladderRace, key: `${region}|${ladderRace}` };
  });
  /** @type {Map<string,number>} */
  const totals = new Map();
  for (const item of prepared) {
    totals.set(item.key, (totals.get(item.key) || 0) + 1);
  }
  /** @type {Map<string,number>} */
  const seen = new Map();
  const series = prepared.map((item) => {
    const ordinal = (seen.get(item.key) || 0) + 1;
    seen.set(item.key, ordinal);
    const baseLabel = `${item.region} · ${coachingRaceName(item.ladderRace)}`;
    const label = (totals.get(item.key) || 0) > 1
      ? `${baseLabel} ${ordinal}`
      : baseLabel;
    return {
      label,
      region: item.region,
      ladderRace: item.ladderRace,
      points: sanitizeMmrPoints(item.row.points),
      peak: sanitizeMmrMark(item.row.peak),
      trough: sanitizeMmrMark(item.row.trough),
      latest: sanitizeMmrMark(item.row.latest),
    };
  });
  return {
    interval: coachingInterval(root.interval || requestedInterval),
    series,
    seriesMeta: {
      total: source.length,
      returned: series.length,
      truncated: source.length > series.length,
      limit: COACHING_MMR_SERIES_LIMIT,
    },
    peak: sanitizeMmrMark(root.peak),
    trough: sanitizeMmrMark(root.trough),
    latest: sanitizeMmrMark(root.latest),
    coverage: numericAllowlist(root.coverage, COACHING_MMR_COVERAGE_KEYS),
  };
}

/** @param {unknown} raw */
function sanitizeMmrPoints(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => {
    const row = asRecord(value);
    const bucket = isoDateOrNull(row.bucket);
    const openMmr = finiteNumber(row.openMmr);
    const closeMmr = finiteNumber(row.closeMmr);
    const minMmr = finiteNumber(row.minMmr);
    const maxMmr = finiteNumber(row.maxMmr);
    if (!bucket || openMmr === null || closeMmr === null
      || minMmr === null || maxMmr === null) return null;
    return {
      bucket,
      openMmr,
      closeMmr,
      minMmr,
      maxMmr,
      wins: nonNegativeCount(row.wins),
      losses: nonNegativeCount(row.losses),
      total: nonNegativeCount(row.total),
    };
  }).filter(Boolean);
}

/** @param {unknown} raw */
function sanitizeMmrMark(raw) {
  const row = asRecord(raw);
  const bucket = isoDateOrNull(row.bucket);
  const mmr = finiteNumber(row.mmr);
  return bucket && mmr !== null ? { bucket, mmr } : null;
}

/** @param {unknown} raw @param {string} tz */
function sanitizeCoachingDailySwings(raw, tz) {
  const daily = asRecord(asRecord(raw).dailySwings);
  const regions = (Array.isArray(daily.regions) ? daily.regions : [])
    .map((value) => {
      const row = asRecord(value);
      return {
        region: coachingRegion(row.region),
        bestGain: sanitizeDailySwing(row.bestGain),
        biggestLoss: sanitizeDailySwing(row.biggestLoss),
        measuredDays: nonNegativeCount(row.measuredDays),
        measuredGames: nonNegativeCount(row.measuredGames),
      };
    });
  return {
    timezone: tz,
    bestGain: sanitizeDailySwing(daily.bestGain),
    biggestLoss: sanitizeDailySwing(daily.biggestLoss),
    measuredDays: nonNegativeCount(daily.measuredDays),
    measuredGames: nonNegativeCount(daily.measuredGames),
    regions,
  };
}

/** @param {unknown} raw */
function sanitizeDailySwing(raw) {
  const row = asRecord(raw);
  const day = isoDateOrNull(row.day);
  if (!day) return null;
  return {
    day,
    netMmr: finiteNumber(row.netMmr) ?? 0,
    measuredGames: nonNegativeCount(row.measuredGames),
    wins: nonNegativeCount(row.wins),
    losses: nonNegativeCount(row.losses),
  };
}

/** @param {unknown} raw */
function sanitizeCoachingNetCoverage(raw) {
  const root = asRecord(raw);
  const rows = Array.isArray(root.coverage) ? root.coverage : [];
  return {
    totalGames: nonNegativeCount(root.totalGames),
    eligibleGames: nonNegativeCount(root.eligibleGames),
    measuredGames: rows
      .reduce((sum, value) => {
        const row = asRecord(value);
        return sum + nonNegativeCount(row.measuredGames);
      }, 0),
    dropped: numericAllowlist(root.dropped, COACHING_NET_DROP_KEYS),
    byOpponentRace: rows.map((value) => {
      const row = asRecord(value);
      return {
        opponentRace: coachingRace(row.race, true) || "U",
        totalGames: nonNegativeCount(row.totalGames),
        eligibleGames: nonNegativeCount(row.eligibleGames),
        measuredGames: nonNegativeCount(row.measuredGames),
        dropped: numericAllowlist(row.dropped, COACHING_NET_DROP_KEYS),
      };
    }),
  };
}

/** @param {unknown} raw @param {string[]} keys */
function numericAllowlist(raw, keys) {
  const row = asRecord(raw);
  return Object.fromEntries(keys.map((key) => [key, nonNegativeCount(row[key])]));
}

/** @param {unknown} value @param {boolean} allowUnknown */
function coachingRace(value, allowUnknown) {
  const race = String(value || "").trim().slice(0, 1).toUpperCase();
  if (race === "P" || race === "T" || race === "Z") {
    return race;
  }
  if (allowUnknown && race === "R") return "R";
  return allowUnknown ? "U" : null;
}

/** @param {unknown} value */
function coachingRegion(value) {
  const region = String(value || "").trim().toUpperCase();
  return ["NA", "EU", "KR", "CN", "SEA"].includes(region) ? region : "U";
}

/** @param {string} race */
function coachingRaceName(race) {
  return ({ P: "Protoss", T: "Terran", Z: "Zerg", R: "Random" })[race]
    || "Unknown race";
}

/** @param {unknown} value @param {string} fallback */
function safeDisplayName(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 160);
}

/** @param {unknown} value @returns {string|null} */
function isoDateOrNull(value) {
  const date = value instanceof Date
    ? value
    : typeof value === "string" || typeof value === "number"
      ? new Date(value)
      : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

/** @param {unknown} value @returns {number|null} */
function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value @returns {number} */
function nonNegativeCount(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? Math.floor(number) : 0;
}

/** @param {unknown} value @returns {Record<string, any>} */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

module.exports = { buildCoachingRouter };
