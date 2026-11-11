"use strict";

const { CUSTOM_BUILD_LIBRARY } = require("../config/constants");
const { validateCustomBuild, validateBuildMeta } = require("../validation/customBuild");

/**
 * Build library safety and organisation routes, registered on the
 * /v1/custom-builds router (routes/customBuilds.js) before its
 * ``/custom-builds/:slug`` reads:
 *
 *   GET   /custom-builds/trash                       Recently deleted (30 days)
 *   POST  /custom-builds/:slug/restore               back from the trash, private
 *   GET   /custom-builds/:slug/revisions             version history (newest 20)
 *   POST  /custom-builds/:slug/revisions/:rev/restore  "Restore this version"
 *   PATCH /custom-builds/:slug/meta                  {pinned?, tags?}
 *   GET   /custom-builds/export                      every build as validated JSON
 *   POST  /custom-builds/import                      {items ≤100, dryRun?, reclassify?}
 *   POST  /custom-builds/:slug/apply-update          take the author's newer version
 *   POST  /custom-builds/:slug/dismiss-update        {version}: keep this copy as is
 *
 * Content writes reuse the router's ``persistBuild`` (upsert, history,
 * replay matching, share state), so a restore or update is undoable from
 * the history like any save.
 */

const SLUG_RE = /^[a-zA-Z0-9._-]{1,80}$/;

/** Fields the author's update replaces; the saver keeps name, notes and skill level. */
const AUTHOR_UPDATE_FIELDS = Object.freeze([
  "race", "vsRace", "matchup", "description", "signature", "perspective", "rules",
  "schemaVersion", "winConditions", "losesTo", "transitionsInto", "buildOrder",
]);

/** @param {import('express').Response} res @param {number} status @param {string} code @param {string} [message] */
function fail(res, status, code, message) {
  res.status(status).json({ error: { code, ...(message ? { message } : {}) } });
}

/**
 * A saved copy updated to the author's current publication. The saver's
 * name, notes and skill level stay; everything the author defines follows.
 * @param {Record<string, any>} current the saver's build (read projection)
 * @param {Record<string, any>} publication public detail with ``build`` and ``version``
 * @param {Date} now
 */
function forkUpdate(current, publication, now) {
  const snapshot = publication.build && typeof publication.build === "object" ? publication.build : {};
  /** @type {Record<string, any>} */
  const next = { slug: current.slug, name: current.name };
  for (const field of AUTHOR_UPDATE_FIELDS) {
    if (snapshot[field] !== undefined && snapshot[field] !== null) next[field] = snapshot[field];
  }
  if (typeof current.notes === "string") next.notes = current.notes;
  if (current.skillLevel !== undefined) next.skillLevel = current.skillLevel;
  next.forkedFrom = {
    communitySlug: current.forkedFrom.communitySlug,
    version: String(publication.version || 1),
    savedAt: now.toISOString(),
  };
  return next;
}

/**
 * @typedef {{
 *   deps: {
 *     customBuilds: import('../services/types').CustomBuildsService,
 *     customBuildLibrary?: import('../services/customBuildLibrary').CustomBuildLibraryService,
 *     community?: import('../services/community').CommunityService,
 *     perGame?: unknown,
 *   },
 *   persistBuild: (req: import('express').Request, userId: string, slug: string, value: Record<string, any>, opts: {
 *     previousBuild: Record<string, any>|null, reclassifyRequested: boolean, reclassifyExplicit?: boolean, wantPublic?: boolean,
 *   }) => Promise<Record<string, any>>,
 *   phaseCacheBust: (userId: string, slug: string) => void,
 * }} LibraryRouteContext
 * @typedef {(handler: (req: import('express').Request, res: import('express').Response, userId: string,
 *   library: import('../services/customBuildLibrary').CustomBuildLibraryService) => Promise<void>) => import('express').RequestHandler} RouteWrapper
 */

/**
 * Authenticated handler wrapper: 503 without the library service, 400 for
 * a malformed ``:slug``, errors to the app's error handler.
 * @param {LibraryRouteContext["deps"]} deps
 * @returns {RouteWrapper}
 */
function routeFor(deps) {
  return (handler) => async (req, res, next) => {
    try {
      const auth = req.auth;
      if (!auth) throw new Error("auth_required");
      if (!deps.customBuildLibrary) {
        fail(res, 503, "library_unavailable");
        return;
      }
      if (req.params.slug !== undefined && !SLUG_RE.test(String(req.params.slug))) {
        fail(res, 400, "bad_request", "invalid slug");
        return;
      }
      await handler(req, res, auth.userId, deps.customBuildLibrary);
    } catch (err) {
      next(err);
    }
  };
}

/** @param {import('express').Router} router @param {LibraryRouteContext} ctx */
function registerCustomBuildLibraryRoutes(router, ctx) {
  const route = routeFor(ctx.deps);
  registerTrashRoutes(router, ctx, route);
  registerHistoryRoutes(router, ctx, route);
  registerImportExportRoutes(router, ctx, route);
  registerForkUpdateRoutes(router, ctx, route);
}

/** Recently deleted: list and restore. @param {import('express').Router} router @param {LibraryRouteContext} ctx @param {RouteWrapper} route */
function registerTrashRoutes(router, { deps, phaseCacheBust }, route) {
  router.get("/custom-builds/trash", route(async (_req, res, userId, library) => {
    res.set("Cache-Control", "private, no-store").json(await library.listTrash(userId));
  }));

  router.post("/custom-builds/:slug/restore", route(async (req, res, userId, library) => {
    const slug = String(req.params.slug);
    if (!(await library.restoreDeleted(userId, slug))) {
      fail(res, 404, "not_in_trash");
      return;
    }
    phaseCacheBust(userId, slug);
    const service = /** @type {any} */ (deps.customBuilds);
    if (typeof service._notifyDefinitionsChanged === "function") service._notifyDefinitionsChanged(userId);
    // ADR 0025: replay matching brings the frozen check-ins back to it.
    let reclassify = null;
    let reclassifyError = null;
    if (deps.perGame) {
      try {
        reclassify = await deps.customBuilds.enqueueReclassify(userId, slug, { replace: true, previousNames: [] });
      } catch (err) {
        reclassifyError = "reclassify_queue_failed";
        if (req.log) req.log.warn({ err, slug, userId }, "custom_build_restore_reclassify_failed");
      }
    }
    res.json({ restored: true, slug, republished: false, reclassify, reclassifyError });
  }));
}

/** Version history, and pin/tags. @param {import('express').Router} router @param {LibraryRouteContext} ctx @param {RouteWrapper} route */
function registerHistoryRoutes(router, { deps, persistBuild }, route) {
  router.patch("/custom-builds/:slug/meta", route(async (req, res, userId, library) => {
    const checked = validateBuildMeta(req.body);
    if (!checked.valid) {
      res.status(400).json({ error: { code: "bad_request", details: checked.errors } });
      return;
    }
    const saved = await library.patchMeta(userId, String(req.params.slug), checked.value);
    if (!saved) fail(res, 404, "not_found");
    else res.json(saved);
  }));

  router.get("/custom-builds/:slug/revisions", route(async (req, res, userId, library) => {
    const slug = String(req.params.slug);
    if (!(await deps.customBuilds.get(userId, slug))) {
      fail(res, 404, "not_found");
      return;
    }
    res.set("Cache-Control", "private, no-store").json({ slug, items: await library.listRevisions(userId, slug) });
  }));

  router.post("/custom-builds/:slug/revisions/:rev/restore", route(async (req, res, userId, library) => {
    const slug = String(req.params.slug);
    const rev = Number(req.params.rev);
    if (!Number.isInteger(rev) || rev < 1) {
      fail(res, 400, "bad_request", "invalid revision");
      return;
    }
    const current = /** @type {Record<string, any>|null} */ (await deps.customBuilds.get(userId, slug));
    const doc = current ? await library.getRevision(userId, slug, rev) : null;
    if (!current || !doc) {
      fail(res, 404, current ? "revision_not_found" : "not_found");
      return;
    }
    const checked = validateCustomBuild({ ...doc, slug });
    if (!checked.valid) {
      res.status(422).json({ error: { code: "revision_invalid", details: checked.errors } });
      return;
    }
    const payload = await persistBuild(req, userId, slug, /** @type {Record<string, any>} */ (checked.value), {
      previousBuild: current,
      reclassifyRequested: true,
      wantPublic: current.isPublic === true ? true : undefined,
    });
    res.json({ ...payload, restoredRev: rev });
  }));
}

/** Export and batched import. @param {import('express').Router} router @param {LibraryRouteContext} ctx @param {RouteWrapper} route */
function registerImportExportRoutes(router, { deps, persistBuild }, route) {
  router.get("/custom-builds/export", route(async (_req, res, userId, library) => {
    const body = await library.exportAll(userId);
    res.set("Cache-Control", "private, no-store")
      .set("Content-Disposition", 'attachment; filename="sc2tools-builds.json"')
      .json(body);
  }));

  router.post("/custom-builds/import", route(async (req, res, userId, library) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items || items.length === 0 || items.length > CUSTOM_BUILD_LIBRARY.IMPORT_BATCH_MAX) {
      fail(res, 400, "bad_request", `send 1-${CUSTOM_BUILD_LIBRARY.IMPORT_BATCH_MAX} items per batch`);
      return;
    }
    const result = await library.importBatch(userId, items, {
      dryRun: body.dryRun === true,
      save: async (slug, value, overwriting) => {
        const previousBuild = overwriting ? /** @type {Record<string, any>|null} */ (await deps.customBuilds.get(userId, slug)) : null;
        await persistBuild(req, userId, slug, value, {
          previousBuild,
          reclassifyRequested: false,
          wantPublic: previousBuild && previousBuild.isPublic === true ? true : undefined,
        });
      },
    });
    // One replay matching run for the whole import, after its last batch.
    let reclassify = null;
    if (body.dryRun !== true && body.reclassify === true && deps.perGame) {
      try {
        reclassify = await deps.customBuilds.enqueueReclassifyAll(userId);
      } catch (err) {
        if (req.log) req.log.warn({ err, userId }, "custom_build_import_reclassify_failed");
      }
    }
    res.json({ ...result, ...(reclassify ? { reclassify } : {}) });
  }));
}

/** A saved community copy: take or dismiss the author's update. @param {import('express').Router} router @param {LibraryRouteContext} ctx @param {RouteWrapper} route */
function registerForkUpdateRoutes(router, { deps, persistBuild }, route) {
  router.post("/custom-builds/:slug/apply-update", route(async (req, res, userId) => {
    const slug = String(req.params.slug);
    const current = /** @type {Record<string, any>|null} */ (await deps.customBuilds.get(userId, slug));
    const communitySlug = current && current.forkedFrom && current.forkedFrom.communitySlug;
    if (!current || typeof communitySlug !== "string" || !communitySlug) {
      fail(res, current ? 409 : 404, current ? "not_a_saved_copy" : "not_found");
      return;
    }
    const publication = deps.community ? await deps.community.getPublic(communitySlug) : null;
    if (!publication) {
      fail(res, 404, "community_build_gone");
      return;
    }
    const checked = validateCustomBuild(forkUpdate(current, publication, new Date()));
    if (!checked.valid) {
      res.status(422).json({ error: { code: "update_invalid", details: checked.errors } });
      return;
    }
    const payload = await persistBuild(req, userId, slug, /** @type {Record<string, any>} */ (checked.value), {
      previousBuild: current,
      reclassifyRequested: true,
      wantPublic: current.isPublic === true ? true : undefined,
    });
    res.json({ ...payload, version: publication.version || 1 });
  }));

  router.post("/custom-builds/:slug/dismiss-update", route(async (req, res, userId, library) => {
    const raw = req.body && typeof req.body === "object" ? req.body.version : undefined;
    const version = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? String(raw)
      : typeof raw === "string" && /^\d{1,9}$/.test(raw) ? raw : null;
    if (!version) {
      fail(res, 400, "bad_request", "version must be a positive integer");
      return;
    }
    if (!(await library.acknowledgeForkVersion(userId, String(req.params.slug), version))) fail(res, 404, "not_found");
    else res.json({ slug: String(req.params.slug), version });
  }));
}

module.exports = { registerCustomBuildLibraryRoutes, forkUpdate };
