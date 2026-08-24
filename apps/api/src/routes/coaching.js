"use strict";

const express = require("express");

// Whole-state payloads carry embedded media (voice memos, images,
// small replays) as base64 — mirror the Locker's own ~12MB budget.
const STATE_BODY_LIMIT = "16mb";

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
  router.use(auth());
  router.use(express.json({ limit: STATE_BODY_LIMIT }));

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
      const { role, studentId } = ctx(req).cr;
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
      res.json({ rev, scoped: false, state });
    } catch (err) {
      next(err);
    }
  });

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
        // Coaches never alter the coach roster — preserve it verbatim.
        toWrite = { ...incoming, coaches: current.state.coaches || [] };
      }
      const out = await deps.coaching.putState(toWrite, rev);
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
        if (!(role === "admin" || role === "coach" || (role === "student" && self))) {
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

module.exports = { buildCoachingRouter };
