"use strict";

const express = require("express");

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
 *   GET  /coaching/students/:userId/games  — slim game list (admin/coach, or the student themself)
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
            students: student ? [student] : [],
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
      const { cr } = ctx(req);
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
      const out = await deps.coaching.putStateWithRosterGuard(toWrite, rev);
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

  router.get(
    "/coaching/students/:userId/games",
    withRole,
    async (req, res, next) => {
      try {
        const { auth, cr } = ctx(req);
        const role = cr.role;
        const target = req.params.userId;
        const self = target === auth.userId;
        let allowed = role === "admin" || (role === "student" && self);
        if (role === "coach" && cr.coachId) {
          const roster = await deps.coaching.getRoster();
          allowed = roster.students.some((student) =>
            student &&
            student.coachId === cr.coachId &&
            student.userId === target,
          );
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
    .filter((student) => student && student.coachId === coachId);
  return {
    ...state,
    coaches: /** @type {any[]} */ (state.coaches || [])
      .map((coach) => ({ id: coach.id, name: coach.name })),
    students,
    assets: pickAssetsForStudents(state, students),
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

module.exports = { buildCoachingRouter };
