/**
 * CUSTOM BUILDS ROUTER
 * ============================================================
 * Express sub-router that owns the local custom-builds cache at
 * data/custom_builds.json and the merged view across the
 * community cache (data/community_builds.cache.json) -- the
 * shared community database promised in the master preamble.
 *
 * Every mutation goes through ajv validation against
 * data/custom_builds.schema.json and an atomic write
 * (.tmp + fsync + rename), per the engineering preamble.
 *
 * Pure helpers live in `./custom_builds_helpers.js` so the
 * router stays under the file-size cap.
 *
 * Endpoints (mounted at /api/custom-builds in index.js):
 *   GET    /                   merged list (custom + community)
 *   GET    /:id                single build
 *   POST   /                   create + queue community POST
 *   PUT    /:id                replace + queue community PUT
 *   PATCH  /:id                partial update
 *   DELETE /:id                soft delete + queue community DELETE
 *   POST   /from-game          derive a draft from a real game
 *   POST   /preview-matches    count matches against meta DB
 *   POST   /reclassify         re-tag every game in meta DB
 *   POST   /sync               run a sync cycle now
 *   GET    /sync/status        last sync, pending count, errors
 *   POST   /:id/vote           forward +1/-1 to community
 *
 * Example:
 *   const router = createCustomBuildsRouter({
 *     dataDir, sync, getIo: () => io,
 *   });
 *   app.use('/api/custom-builds', router);
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const H = require('./custom_builds_helpers');

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL = 500;

const CUSTOM_FILE = 'custom_builds.json';
const CACHE_FILE = 'community_builds.cache.json';
const META_DB_FILE = 'meta_database.json';
const SCHEMA_FILE = 'custom_builds.schema.json';
const RECLASSIFY_PROGRESS_EVERY = 10;

/**
 * Compile the v2 ajv schema once at router boot. A failure here
 * is a hard config error -- the router refuses to start.
 *
 * @param {string} dataDir
 * @returns {Function}
 */
function compileBuildValidator(dataDir) {
  const schemaPath = path.join(dataDir, SCHEMA_FILE);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'custom_builds.schema.json');
  return ajv.getSchema('custom_builds.schema.json#/definitions/build');
}

/**
 * Wrap async handlers so unhandled rejections become 500s.
 *
 * @param {Function} fn
 * @returns {Function}
 */
function wrap(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[custom-builds]', req.method, req.path, String(err && err.message ? err.message : err));
        if (!res.headersSent) {
          res.status(HTTP_INTERNAL).json({ error: 'internal_error' });
        }
      });
  };
}

/**
 * 400 with structured ajv error payload, returns true.
 *
 * @param {object} res
 * @param {string} code
 * @param {object} [details]
 * @returns {boolean}
 */
function badRequest(res, code, details) {
  res.status(HTTP_BAD_REQUEST).json({ error: code, details: details || null });
  return true;
}

/**
 * Run schema validation; on failure, send 400 and return true.
 *
 * @param {Function} validator
 * @param {object} body
 * @param {object} res
 * @returns {boolean}
 */
function validateOrFail(validator, body, res) {
  if (validator(body)) return false;
  return badRequest(res, 'validation_failed', validator.errors || []);
}

/**
 * Stamp timestamps + author + sync_state for a fresh POST.
 *
 * @param {object} ctx
 * @param {object} body
 * @returns {object}
 */
function prepareDraftForCreate(ctx, body) {
  const data = H.readCustomFile(ctx.customPath);
  const existingIds = new Set(data.builds.map((b) => b.id));
  const id = body.id && H.ID_PATTERN.test(body.id)
    ? body.id
    : H.uniqueIdFor(body.name || 'build', existingIds);
  const now = new Date().toISOString();
  return H.normalizeBuild(
    { ...body, id },
    {
      created_at: body.created_at || now,
      updated_at: now,
      author: body.author || H.getAuthorDisplay(ctx.dataDir),
      sync_state: 'pending',
    }
  );
}

/**
 * Resolve the event list for a /from-game request.
 *
 * @param {object} ctx
 * @param {object} body
 * @returns {Array<object>|null}
 */
function collectEventsForDraft(ctx, body) {
  if (Array.isArray(body.events)) {
    return body.events.filter((e) => e && typeof e.t === 'number' && typeof e.what === 'string');
  }
  if (typeof body.build_name === 'string' && Number.isInteger(body.game_index)) {
    const meta = H.readJsonOrNull(path.join(ctx.dataDir, META_DB_FILE));
    if (!meta) return null;
    const games = meta[body.build_name] && meta[body.build_name].games;
    if (!Array.isArray(games) || !games[body.game_index]) return null;
    return H.extractGameEvents(games[body.game_index]);
  }
  return null;
}

/**
 * Build a draft response payload for /from-game.
 *
 * @param {Array<object>} events
 * @param {object} body
 * @returns {object}
 */
function buildDraftFromEvents(events, body) {
  return {
    id: '',
    name: body.name || 'Derived from game',
    race: body.race || 'Protoss',
    vs_race: body.vs_race || 'Zerg',
    skill_level: null,
    description: body.description || 'Auto-derived from a real game.',
    win_conditions: [],
    loses_to: [],
    transitions_into: [],
    rules: H.pickRulesFromEvents(events),
    source_replay_id: body.source_replay_id || (body.game_id || null),
  };
}

/**
 * Emit a Socket.io progress event if the io getter is wired.
 *
 * @param {object} ctx
 * @param {number} processed
 * @param {number} total
 * @param {number} changed
 */
function emitProgress(ctx, processed, total, changed) {
  const io = ctx.getIo && ctx.getIo();
  if (!io || typeof io.emit !== 'function') return;
  io.emit('reclassify_progress', { processed, total, changed });
}

/**
 * Re-classify every game in the meta DB against the merged
 * build set. Mutates `meta` in place.
 *
 * @param {object} ctx
 * @param {object} meta
 * @returns {Promise<{scanned: number, changed: number, builds: number}>}
 */
async function reclassifyAllGames(ctx, meta) {
  const builds = H.readMergedList(ctx.customPath, ctx.cachePath).builds;
  const total = H.countGames(meta);
  let processed = 0;
  let changed = 0;
  for (const buildName of Object.keys(meta)) {
    const games = (meta[buildName] && meta[buildName].games) || [];
    for (let i = games.length - 1; i >= 0; i--) {
      const events = H.extractGameEvents(games[i]);
      const best = H.bestMatchV3(events, builds, games[i], buildName);
      processed += 1;
      if (best && best.name && best.name !== buildName) {
        H.moveGame(meta, buildName, best.name, i);
        changed += 1;
      }
      if (processed % RECLASSIFY_PROGRESS_EVERY === 0) emitProgress(ctx, processed, total, changed);
    }
  }
  emitProgress(ctx, total, total, changed);
  return { scanned: total, changed, builds: builds.length };
}

/**
 * GET /
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleList(ctx) {
  return wrap((req, res) => {
    const merged = H.readMergedList(ctx.customPath, ctx.cachePath);
    res.status(HTTP_OK).json({
      version: 2,
      builds: merged.builds,
      counts: {
        custom: merged.customCount,
        community_cache: merged.cacheCount,
        total: merged.builds.length,
      },
    });
  });
}

/**
 * GET /:id
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleGet(ctx) {
  return wrap((req, res) => {
    const merged = H.readMergedList(ctx.customPath, ctx.cachePath);
    const found = merged.builds.find((b) => b.id === req.params.id);
    if (!found) {
      res.status(HTTP_NOT_FOUND).json({ error: 'not_found' });
      return;
    }
    res.status(HTTP_OK).json(found);
  });
}

/**
 * POST /
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleCreate(ctx) {
  return wrap((req, res) => {
    const draft = prepareDraftForCreate(ctx, req.body || {});
    if (validateOrFail(ctx.validator, draft, res)) return;
    const data = H.readCustomFile(ctx.customPath);
    if (H.findById(data.builds, draft.id).build) {
      res.status(HTTP_CONFLICT).json({ error: 'build_exists' });
      return;
    }
    data.builds.push(draft);
    H.atomicWriteJson(ctx.customPath, data);
    if (ctx.sync) ctx.sync.queueUpsert(draft);
    res.status(HTTP_CREATED).json(draft);
  });
}

/**
 * PUT /:id
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleReplace(ctx) {
  return wrap((req, res) => {
    const id = req.params.id;
    const data = H.readCustomFile(ctx.customPath);
    const found = H.findById(data.builds, id);
    if (!found.build) {
      res.status(HTTP_NOT_FOUND).json({ error: 'not_found' });
      return;
    }
    const draft = H.normalizeBuild(
      { ...(req.body || {}), id },
      {
        created_at: found.build.created_at,
        updated_at: new Date().toISOString(),
        author: found.build.author,
        sync_state: 'pending',
      }
    );
    if (validateOrFail(ctx.validator, draft, res)) return;
    data.builds[found.index] = { ...draft, remote_version: found.build.remote_version };
    H.atomicWriteJson(ctx.customPath, data);
    if (ctx.sync) ctx.sync.queueUpsert(data.builds[found.index]);
    res.status(HTTP_OK).json(data.builds[found.index]);
  });
}

/**
 * PATCH /:id
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handlePatch(ctx) {
  return wrap((req, res) => {
    const id = req.params.id;
    const data = H.readCustomFile(ctx.customPath);
    const found = H.findById(data.builds, id);
    if (!found.build) {
      res.status(HTTP_NOT_FOUND).json({ error: 'not_found' });
      return;
    }
    const merged = H.applyPatch(found.build, req.body || {});
    if (validateOrFail(ctx.validator, merged, res)) return;
    data.builds[found.index] = merged;
    H.atomicWriteJson(ctx.customPath, data);
    if (ctx.sync) ctx.sync.queueUpsert(merged);
    res.status(HTTP_OK).json(merged);
  });
}

/**
 * DELETE /:id
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleDelete(ctx) {
  return wrap((req, res) => {
    const id = req.params.id;
    const data = H.readCustomFile(ctx.customPath);
    const found = H.findById(data.builds, id);
    if (!found.build) {
      res.status(HTTP_NOT_FOUND).json({ error: 'not_found' });
      return;
    }
    data.builds.splice(found.index, 1);
    H.atomicWriteJson(ctx.customPath, data);
    if (ctx.sync) ctx.sync.queueDelete(id);
    res.status(HTTP_NO_CONTENT).end();
  });
}

/**
 * POST /from-game
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleFromGame(ctx) {
  return wrap((req, res) => {
    const body = req.body || {};
    const events = collectEventsForDraft(ctx, body);
    if (!events) {
      badRequest(res, 'no_events_resolved');
      return;
    }
    const draft = buildDraftFromEvents(events, body);
    // Stage 7.5b: rules array is intentionally empty by default —
    // user adds rules manually via the editor's [+] click-to-add UI.
    res.status(HTTP_OK).json({ draft, event_count: events.length });
  });
}

/**
 * POST /preview-matches
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handlePreviewMatches(ctx) {
  return wrap((req, res) => {
    const candidate = req.body || {};
    if (!Array.isArray(candidate.rules) || candidate.rules.length === 0) {
      badRequest(res, 'missing_rules');
      return;
    }
    const meta = H.readJsonOrNull(path.join(ctx.dataDir, META_DB_FILE)) || {};
    const result = H.previewMatchesV3(meta, candidate);
    res.status(HTTP_OK).json({
      matches: result.matches,
      almost_matches: result.almostMatches,
      scanned_games: result.scanned,
      truncated: result.truncated,
    });
  });
}

/**
 * POST /reclassify
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleReclassify(ctx) {
  return wrap(async (req, res) => {
    const metaPath = path.join(ctx.dataDir, META_DB_FILE);
    const meta = H.readJsonOrNull(metaPath);
    if (!meta) {
      badRequest(res, 'no_meta_database');
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(metaPath, metaPath + '.pre-reclassify-' + stamp);
    const summary = await reclassifyAllGames(ctx, meta);
    H.atomicWriteJson(metaPath, meta);
    res.status(HTTP_OK).json(summary);
  });
}

/**
 * POST /sync
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleSyncNow(ctx) {
  return wrap(async (req, res) => {
    if (!ctx.sync) {
      badRequest(res, 'sync_disabled');
      return;
    }
    const result = await ctx.sync.syncNow();
    res.status(HTTP_OK).json({ ...ctx.sync.getStatus(), ...result });
  });
}

/**
 * GET /sync/status
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleSyncStatus(ctx) {
  return wrap((req, res) => {
    const status = ctx.sync ? ctx.sync.getStatus() : { sync_disabled: true };
    res.status(HTTP_OK).json(status);
  });
}

/**
 * POST /:id/vote
 *
 * @param {object} ctx
 * @returns {Function}
 */
function handleVote(ctx) {
  return wrap((req, res) => {
    const id = req.params.id;
    const vote = (req.body && req.body.vote) === -1 ? -1 : 1;
    if (!ctx.sync) {
      badRequest(res, 'sync_disabled');
      return;
    }
    ctx.sync.queueVote(id, vote);
    res.status(HTTP_OK).json({ queued: true, vote, id });
  });
}

/**
 * Construct the express.Router and wire all handlers. Static
 * routes are registered before parameterised ones so /from-game,
 * /preview-matches, /reclassify, /sync, /sync/status do not get
 * captured by /:id.
 *
 * @param {object} opts
 * @param {string} opts.dataDir Absolute path to data folder.
 * @param {object} [opts.sync] Community sync service (or null).
 * @param {Function} [opts.getIo] Lazy Socket.io getter.
 * @returns {import('express').Router}
 */
function createCustomBuildsRouter(opts) {
  const dataDir = opts.dataDir;
  if (!dataDir) throw new Error('custom_builds: missing dataDir');
  const ctx = {
    dataDir,
    customPath: path.join(dataDir, CUSTOM_FILE),
    cachePath: path.join(dataDir, CACHE_FILE),
    validator: compileBuildValidator(dataDir),
    sync: opts.sync || null,
    getIo: opts.getIo || (() => null),
  };
  const router = express.Router();
  router.get('/', handleList(ctx));
  router.post('/from-game', handleFromGame(ctx));
  router.post('/preview-matches', handlePreviewMatches(ctx));
  router.post('/reclassify', handleReclassify(ctx));
  router.post('/sync', handleSyncNow(ctx));
  router.get('/sync/status', handleSyncStatus(ctx));
  router.post('/', handleCreate(ctx));
  router.get('/:id', handleGet(ctx));
  router.put('/:id', handleReplace(ctx));
  router.patch('/:id', handlePatch(ctx));
  router.delete('/:id', handleDelete(ctx));
  router.post('/:id/vote', handleVote(ctx));
  return router;
}

module.exports = {
  createCustomBuildsRouter,
  __test__: { compileBuildValidator, prepareDraftForCreate, reclassifyAllGames },
};
