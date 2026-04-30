/**
 * COMMUNITY SYNC SERVICE
 * ============================================================
 * Thin HMAC-signed client for the Stage 7.3 community-builds
 * service (see docs/community-builds-api.md). Owns three things:
 *
 *   1. The persistent client identity (data/.community_client_id)
 *      and the cached server pepper handed out by GET /handshake.
 *   2. The pending-write queue (data/community_sync_queue.json)
 *      for POST/PUT/DELETE/vote that need to be retried with
 *      exponential backoff when offline.
 *   3. The 15-minute incremental-sync worker that pulls
 *      /sync?since=<epoch> and refreshes
 *      data/community_builds.cache.json.
 *
 * The service is **deliberately pure** -- no Express, no Socket.io,
 * no globals. The router and the index.js startup wire it up. Tests
 * inject a fake `fetch` and a temp `dataDir` to keep the network
 * out of CI.
 *
 * The router maps local snake_case fields to the service's
 * camelCase in {toRemote, fromRemote} -- see docs/custom-builds-spec.md
 * for the full mapping.
 *
 * Engineering preamble compliance:
 *   - Atomic JSON writes (.tmp + fsync + rename).
 *   - Structured pino logging, no PII (we hash author display + id).
 *   - 30-line function cap, narrowest catches, env-based config.
 *
 * Example:
 *   const svc = createCommunitySyncService({ dataDir, logger });
 *   await svc.start();
 *   await svc.queueUpsert(buildObject);
 *   const status = svc.getStatus();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// settings-pr1n: centralised atomic writes (Hard Rule #4). Replaces the
// duplicated atomicWriteJson + the bare fs.writeFileSync calls below.
const atomicFs = require('../lib/atomic-fs');

const DEFAULT_BASE_URL = 'https://sc2-community-builds.onrender.com';
const ROUTE_PREFIX = '/v1/community-builds';
const QUEUE_FILE = 'community_sync_queue.json';
const CACHE_FILE = 'community_builds.cache.json';
const CLIENT_ID_FILE = '.community_client_id';
const PEPPER_CACHE_FILE = '.community_pepper';
const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const HTTP_TIMEOUT_MS = 30 * 1000; // 30s read per preamble
const MAX_QUEUE_BACKOFF_MS = 60 * 60 * 1000; // 1h cap
const QUEUE_BASE_BACKOFF_MS = 30 * 1000; // 30s
const CLIENT_ID_BYTES = 32; // 64 hex chars
const HEADER_CLIENT_ID = 'X-Client-Id';
const HEADER_CLIENT_SIG = 'X-Client-Signature';

/**
 * Hash a string for safe logging. We never log opponent names,
 * battle tags, or push tokens at INFO; this lets us correlate
 * without leaking PII.
 *
 * Example:
 *   logger.info({ buildId: hashForLog('battle-tag') }, 'queued');
 *
 * @param {string} value
 * @returns {string} 8 hex chars from sha256(value).
 */
function hashForLog(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * Atomically write a JSON file (.tmp + fsync + rename).
 * Mirrors persistMetaDb in analyzer.js per the master preamble.
 *
 * @param {string} filePath Absolute path.
 * @param {object} data
 */
// settings-pr1n: thin wrapper that delegates to the central helper so
// every existing call site inside this module keeps working unchanged.
function atomicWriteJson(filePath, data) {
  atomicFs.atomicWriteJson(filePath, data);
}

/**
 * Read a JSON file, stripping a leading BOM if present.
 * Returns null when the file doesn't exist.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let raw = fs.readFileSync(filePath, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return null;
  return JSON.parse(raw);
}

/**
 * Convert a local snake_case build (the v2 shape on disk) into
 * the camelCase shape the community service expects.
 *
 * @param {object} local
 * @param {string} authorClientId
 * @returns {object}
 */
function toRemote(local, authorClientId) {
  return {
    id: local.id,
    name: local.name,
    race: local.race,
    vsRace: local.vs_race,
    tier: local.tier == null ? null : local.tier,
    description: local.description || '',
    winConditions: local.win_conditions || [],
    losesTo: local.loses_to || [],
    transitionsInto: local.transitions_into || [],
    signature: local.signature.map((sig) => ({
      t: sig.t,
      what: sig.what,
      weight: sig.weight,
    })),
    toleranceSec: local.tolerance_sec,
    minMatchScore: local.min_match_score,
    authorClientId,
    authorDisplay: local.author || 'local',
  };
}

/**
 * Convert a remote camelCase build back into the local v2 shape.
 *
 * @param {object} remote
 * @returns {object}
 */
function fromRemote(remote) {
  const createdIso = epochToIso(remote.createdAt);
  const updatedIso = epochToIso(remote.updatedAt);
  return {
    id: remote.id,
    name: remote.name,
    race: remote.race,
    vs_race: remote.vsRace,
    tier: remote.tier == null ? null : remote.tier,
    description: remote.description || '',
    win_conditions: remote.winConditions || [],
    loses_to: remote.losesTo || [],
    transitions_into: remote.transitionsInto || [],
    signature: (remote.signature || []).map((sig) => ({
      t: sig.t,
      what: sig.what,
      weight: sig.weight,
    })),
    tolerance_sec: remote.toleranceSec,
    min_match_score: remote.minMatchScore,
    source_replay_id: null,
    created_at: createdIso,
    updated_at: updatedIso,
    author: remote.authorDisplay || 'community',
    sync_state: 'synced',
    remote_version: remote.version || 1,
    upvotes: remote.upvotes || 0,
    downvotes: remote.downvotes || 0,
  };
}

/**
 * Convert an integer epoch-ms timestamp to ISO 8601.
 *
 * @param {number|null|undefined} epochMs
 * @returns {string}
 */
function epochToIso(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return new Date().toISOString();
  }
  return new Date(epochMs).toISOString();
}

/**
 * Get-or-create the persistent client_id used for HMAC auth.
 * Stored once in dataDir/.community_client_id; never logged.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function ensureClientId(dataDir) {
  const filePath = path.join(dataDir, CLIENT_ID_FILE);
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (/^[0-9a-f]{32,128}$/.test(raw)) return raw;
  }
  const id = crypto.randomBytes(CLIENT_ID_BYTES).toString('hex');
  atomicFs.atomicWriteString(filePath, id, { encoding: 'utf8', mode: 0o600 });
  return id;
}

/**
 * Read a cached pepper hex from disk, if any.
 *
 * @param {string} dataDir
 * @returns {string|null}
 */
function readCachedPepper(dataDir) {
  try {
    const filePath = path.join(dataDir, PEPPER_CACHE_FILE);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch (_) {
    return null;
  }
}

/**
 * Persist a fetched pepper hex to disk with 0o600 perms.
 *
 * @param {string} dataDir
 * @param {string} pepperHex
 */
function writeCachedPepper(dataDir, pepperHex) {
  atomicFs.atomicWriteString(path.join(dataDir, PEPPER_CACHE_FILE), pepperHex, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Fetch with a hard timeout. Wraps the global fetch in
 * AbortController so a hung server can never wedge the worker.
 *
 * @param {Function} fetchImpl
 * @param {string} url
 * @param {object} init
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the HMAC-SHA256 hex signature over the request body.
 * Pepper hex string is converted to bytes per docs/community-builds-api.md.
 *
 * @param {string} pepperHex
 * @param {string|Buffer} body
 * @returns {string}
 */
function signBody(pepperHex, body) {
  const pepperBuf = Buffer.from(pepperHex, 'hex');
  return crypto.createHmac('sha256', pepperBuf).update(body || '').digest('hex');
}

/**
 * Default no-op logger; tests inject a real one.
 *
 * @returns {object}
 */
function nullLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
}

/**
 * Compute exponential backoff capped at MAX_QUEUE_BACKOFF_MS.
 *
 * @param {number} attempts How many times the entry has failed already.
 * @returns {number}
 */
function backoffFor(attempts) {
  const exp = QUEUE_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, MAX_QUEUE_BACKOFF_MS);
}

/**
 * Read the persisted queue, returning the empty shape if missing.
 *
 * @param {string} queuePath
 * @returns {{version: number, entries: Array<object>, last_error: string|null}}
 */
function readQueue(queuePath) {
  const data = readJsonOrNull(queuePath);
  if (!data || !Array.isArray(data.entries)) {
    return { version: 1, entries: [], last_error: null };
  }
  return data;
}

/**
 * Read the cache file, returning the empty shape if missing.
 *
 * @param {string} cachePath
 * @returns {{version: number, last_sync_at: string|null, server_now: number, builds: Array<object>}}
 */
function readCache(cachePath) {
  const data = readJsonOrNull(cachePath);
  if (!data || !Array.isArray(data.builds)) {
    return { version: 2, last_sync_at: null, server_now: 0, builds: [] };
  }
  return data;
}

/**
 * Construct a community sync service bound to a specific dataDir.
 * Returns an object with start/stop, queue mutators, and a
 * read-only status accessor. None of the methods throw -- failure
 * is reflected in `getStatus().last_error`.
 *
 * @param {object} opts
 * @param {string} opts.dataDir Absolute path to the data folder.
 * @param {string} [opts.baseUrl] Override the API base URL.
 * @param {Function} [opts.fetchImpl] Injectable fetch (default: global fetch).
 * @param {object} [opts.logger] Pino-shaped logger.
 * @param {number} [opts.intervalMs] Override the periodic-sync interval.
 * @returns {object}
 */
function createCommunitySyncService(opts) {
  const dataDir = opts.dataDir;
  if (!dataDir || !fs.existsSync(dataDir)) {
    throw new Error('community_sync: dataDir does not exist');
  }
  const baseUrl = (opts.baseUrl || process.env.COMMUNITY_BUILDS_URL || DEFAULT_BASE_URL).replace(
    /\/$/,
    ''
  );
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const logger = opts.logger || nullLogger();
  const intervalMs = opts.intervalMs || SYNC_INTERVAL_MS;
  const queuePath = path.join(dataDir, QUEUE_FILE);
  const cachePath = path.join(dataDir, CACHE_FILE);
  const clientId = ensureClientId(dataDir);
  const state = {
    pepperHex: readCachedPepper(dataDir),
    timer: null,
    inFlight: false,
    lastSyncAt: null,
    lastError: null,
    pendingCount: readQueue(queuePath).entries.length,
  };
  return buildServiceApi({ state, baseUrl, fetchImpl, logger, intervalMs, queuePath, cachePath, clientId, dataDir });
}

/**
 * Compose the public service API. Split out so the constructor
 * stays under the 30-line cap.
 *
 * @param {object} ctx
 * @returns {object}
 */
function buildServiceApi(ctx) {
  return {
    getBaseUrl: () => ctx.baseUrl,
    getClientId: () => ctx.clientId,
    getStatus: () => buildStatus(ctx),
    start: () => startWorker(ctx),
    stop: () => stopWorker(ctx),
    syncNow: () => runSync(ctx),
    queueUpsert: (build) => enqueue(ctx, { kind: 'upsert', build }),
    queueDelete: (id) => enqueue(ctx, { kind: 'delete', id }),
    queueVote: (id, vote) => enqueue(ctx, { kind: 'vote', id, vote }),
    readCache: () => readCache(ctx.cachePath),
    readQueue: () => readQueue(ctx.queuePath),
  };
}

/**
 * Snapshot of public sync state for the GET /sync/status endpoint.
 *
 * @param {object} ctx
 * @returns {object}
 */
function buildStatus(ctx) {
  const queue = readQueue(ctx.queuePath);
  const cache = readCache(ctx.cachePath);
  return {
    base_url: ctx.baseUrl,
    client_id: ctx.clientId,
    last_sync_at: ctx.state.lastSyncAt || cache.last_sync_at,
    last_error: ctx.state.lastError,
    pending_count: queue.entries.length,
    in_flight: ctx.state.inFlight,
    server_now: cache.server_now,
    cache_count: cache.builds.length,
  };
}

/**
 * Start the periodic worker. Idempotent.
 *
 * @param {object} ctx
 */
function startWorker(ctx) {
  if (ctx.state.timer) return;
  ctx.state.timer = setInterval(() => {
    runSync(ctx).catch((err) => {
      ctx.logger.warn({ err: String(err) }, 'community_sync.tick_failed');
    });
  }, ctx.intervalMs);
  if (typeof ctx.state.timer.unref === 'function') ctx.state.timer.unref();
  // Kick off an initial sync immediately, but don't block the caller.
  runSync(ctx).catch((err) => {
    ctx.logger.warn({ err: String(err) }, 'community_sync.initial_failed');
  });
}

/**
 * Stop the periodic worker.
 *
 * @param {object} ctx
 */
function stopWorker(ctx) {
  if (ctx.state.timer) {
    clearInterval(ctx.state.timer);
    ctx.state.timer = null;
  }
}

/**
 * Persist a new entry to the queue. Caller must already have
 * resolved the snake_case→camelCase translation.
 *
 * @param {object} ctx
 * @param {object} entry
 */
function enqueue(ctx, entry) {
  const queue = readQueue(ctx.queuePath);
  queue.entries.push({
    ...entry,
    id: entry.id || (entry.build && entry.build.id),
    enqueued_at: new Date().toISOString(),
    attempts: 0,
    next_attempt_at: 0,
  });
  atomicWriteJson(ctx.queuePath, queue);
  ctx.state.pendingCount = queue.entries.length;
  ctx.logger.info({ kind: entry.kind, build: hashForLog(entry.id || (entry.build && entry.build.id)) }, 'community_sync.enqueue');
}

/**
 * Run one full sync cycle: ensure pepper, drain queue, pull diff.
 * Errors are caught and recorded in state.lastError -- callers
 * never see throws.
 *
 * @param {object} ctx
 * @returns {Promise<{synced: number, pulled: number}>}
 */
async function runSync(ctx) {
  if (ctx.state.inFlight) return { synced: 0, pulled: 0 };
  ctx.state.inFlight = true;
  try {
    await ensurePepper(ctx);
    const synced = await drainQueue(ctx);
    const pulled = await pullIncremental(ctx);
    ctx.state.lastSyncAt = new Date().toISOString();
    ctx.state.lastError = null;
    return { synced, pulled };
  } catch (err) {
    ctx.state.lastError = String(err && err.message ? err.message : err);
    ctx.logger.warn({ err: ctx.state.lastError }, 'community_sync.cycle_failed');
    return { synced: 0, pulled: 0 };
  } finally {
    ctx.state.inFlight = false;
  }
}

/**
 * Fetch and cache the server pepper if we don't have one yet.
 * GET /handshake is unauthenticated.
 *
 * @param {object} ctx
 */
async function ensurePepper(ctx) {
  if (ctx.state.pepperHex) return;
  const url = ctx.baseUrl + ROUTE_PREFIX + '/handshake';
  const res = await fetchWithTimeout(ctx.fetchImpl, url, { method: 'GET' }, HTTP_TIMEOUT_MS);
  if (!res.ok) throw new Error('handshake_failed_' + res.status);
  const body = await res.json();
  if (!body || typeof body.pepperHex !== 'string') {
    throw new Error('handshake_bad_payload');
  }
  ctx.state.pepperHex = body.pepperHex;
  writeCachedPepper(ctx.dataDir, body.pepperHex);
}

/**
 * Drain pending writes. Each successful entry is removed; failed
 * entries are retried with exponential backoff.
 *
 * @param {object} ctx
 * @returns {Promise<number>} count of entries successfully drained.
 */
async function drainQueue(ctx) {
  const queue = readQueue(ctx.queuePath);
  if (queue.entries.length === 0) return 0;
  const remaining = [];
  let synced = 0;
  for (const entry of queue.entries) {
    if (entry.next_attempt_at && Date.now() < entry.next_attempt_at) {
      remaining.push(entry);
      continue;
    }
    const ok = await tryEntry(ctx, entry).catch(() => false);
    if (ok) {
      synced += 1;
    } else {
      remaining.push(advanceBackoff(entry));
    }
  }
  queue.entries = remaining;
  queue.last_error = ctx.state.lastError;
  atomicWriteJson(ctx.queuePath, queue);
  ctx.state.pendingCount = remaining.length;
  return synced;
}

/**
 * Bump retry counters on a failed queue entry.
 *
 * @param {object} entry
 * @returns {object}
 */
function advanceBackoff(entry) {
  const attempts = (entry.attempts || 0) + 1;
  return { ...entry, attempts, next_attempt_at: Date.now() + backoffFor(attempts) };
}

/**
 * Execute a single queue entry against the community service.
 *
 * @param {object} ctx
 * @param {object} entry
 * @returns {Promise<boolean>} true if the entry should be removed.
 */
async function tryEntry(ctx, entry) {
  if (entry.kind === 'upsert') return tryUpsert(ctx, entry);
  if (entry.kind === 'delete') return tryDelete(ctx, entry);
  if (entry.kind === 'vote') return tryVote(ctx, entry);
  ctx.logger.warn({ kind: entry.kind }, 'community_sync.unknown_entry');
  return true; // drop unknown entries
}

/**
 * Attempt POST or PUT for a build. POST if remote_version is
 * absent; PUT otherwise. 409 on POST falls through to PUT.
 *
 * @param {object} ctx
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
async function tryUpsert(ctx, entry) {
  const remote = toRemote(entry.build, ctx.clientId);
  const isNew = !entry.build.remote_version;
  const method = isNew ? 'POST' : 'PUT';
  const url = ctx.baseUrl + ROUTE_PREFIX + (isNew ? '' : '/' + encodeURIComponent(entry.build.id));
  const res = await signedFetch(ctx, url, method, remote);
  if (res.ok) return markBuildSynced(ctx, entry.build, await res.json());
  if (res.status === 409 && isNew) {
    // Build already exists on the server (collision with our own
    // earlier upload from another device). Retry as PUT.
    const putUrl = ctx.baseUrl + ROUTE_PREFIX + '/' + encodeURIComponent(entry.build.id);
    const put = await signedFetch(ctx, putUrl, 'PUT', remote);
    if (put.ok) return markBuildSynced(ctx, entry.build, await put.json());
  }
  ctx.logger.warn(
    { status: res.status, build: hashForLog(entry.build.id) },
    'community_sync.upsert_failed'
  );
  return false;
}

/**
 * Attempt DELETE for a build id.
 *
 * @param {object} ctx
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
async function tryDelete(ctx, entry) {
  const url = ctx.baseUrl + ROUTE_PREFIX + '/' + encodeURIComponent(entry.id);
  const res = await signedFetch(ctx, url, 'DELETE', null);
  if (res.ok || res.status === 404) return true;
  ctx.logger.warn({ status: res.status, build: hashForLog(entry.id) }, 'community_sync.delete_failed');
  return false;
}

/**
 * Attempt POST /:id/vote.
 *
 * @param {object} ctx
 * @param {object} entry
 * @returns {Promise<boolean>}
 */
async function tryVote(ctx, entry) {
  const url = ctx.baseUrl + ROUTE_PREFIX + '/' + encodeURIComponent(entry.id) + '/vote';
  const res = await signedFetch(ctx, url, 'POST', { vote: entry.vote });
  if (res.ok) return true;
  ctx.logger.warn({ status: res.status, build: hashForLog(entry.id) }, 'community_sync.vote_failed');
  return false;
}

/**
 * Persist sync metadata back into the local custom_builds.json
 * after a successful upsert. Called by tryUpsert; we read the
 * file, find the build by id, and flip sync_state.
 *
 * @param {object} ctx
 * @param {object} localBuild
 * @param {object} serverPayload
 * @returns {boolean}
 */
function markBuildSynced(ctx, localBuild, serverPayload) {
  const filePath = path.join(ctx.dataDir, 'custom_builds.json');
  const data = readJsonOrNull(filePath);
  if (!data || !Array.isArray(data.builds)) return true;
  for (const b of data.builds) {
    if (b.id === localBuild.id) {
      b.sync_state = 'synced';
      b.remote_version = serverPayload && serverPayload.version ? serverPayload.version : b.remote_version || 1;
      b.updated_at = epochToIso(serverPayload && serverPayload.updatedAt);
    }
  }
  atomicWriteJson(filePath, data);
  ctx.logger.info({ build: hashForLog(localBuild.id) }, 'community_sync.upsert_ok');
  return true;
}

/**
 * Pull /sync?since=<server_now> and merge the diff into the
 * local cache. New entries are added; deletes are pruned.
 *
 * @param {object} ctx
 * @returns {Promise<number>} count of upserts pulled.
 */
async function pullIncremental(ctx) {
  const cache = readCache(ctx.cachePath);
  const since = cache.server_now || 0;
  const url = ctx.baseUrl + ROUTE_PREFIX + '/sync?since=' + encodeURIComponent(String(since));
  const res = await signedFetch(ctx, url, 'GET', null);
  if (!res.ok) {
    ctx.logger.warn({ status: res.status }, 'community_sync.pull_failed');
    return 0;
  }
  const body = await res.json();
  return mergeDiffIntoCache(ctx, cache, body);
}

/**
 * Apply a server-side diff to the cache file.
 *
 * @param {object} ctx
 * @param {object} cache
 * @param {object} diff
 * @returns {number}
 */
function mergeDiffIntoCache(ctx, cache, diff) {
  const upserts = Array.isArray(diff.upserts) ? diff.upserts : [];
  const deletes = new Set(Array.isArray(diff.deletes) ? diff.deletes : []);
  const byId = new Map(cache.builds.map((b) => [b.id, b]));
  for (const remote of upserts) byId.set(remote.id, fromRemote(remote));
  for (const id of deletes) byId.delete(id);
  cache.builds = Array.from(byId.values());
  cache.server_now = typeof diff.serverNow === 'number' ? diff.serverNow : cache.server_now;
  cache.last_sync_at = new Date().toISOString();
  cache.version = 2;
  atomicWriteJson(ctx.cachePath, cache);
  ctx.logger.info({ upserts: upserts.length, deletes: deletes.size }, 'community_sync.pull_ok');
  return upserts.length;
}

/**
 * Issue a signed request. Body is JSON-stringified once (to keep
 * signature & wire bytes identical) and signed before sending.
 *
 * @param {object} ctx
 * @param {string} url
 * @param {string} method
 * @param {object|null} bodyObj
 * @returns {Promise<Response>}
 */
async function signedFetch(ctx, url, method, bodyObj) {
  const headers = { [HEADER_CLIENT_ID]: ctx.clientId };
  let bodyStr = '';
  if (bodyObj !== null && bodyObj !== undefined) {
    bodyStr = JSON.stringify(bodyObj);
    headers['Content-Type'] = 'application/json';
  }
  headers[HEADER_CLIENT_SIG] = signBody(ctx.state.pepperHex || '', bodyStr);
  return fetchWithTimeout(
    ctx.fetchImpl,
    url,
    { method, headers, body: bodyStr || undefined },
    HTTP_TIMEOUT_MS
  );
}

module.exports = {
  createCommunitySyncService,
  // Exported for tests:
  __test__: {
    toRemote,
    fromRemote,
    backoffFor,
    signBody,
    atomicWriteJson,
    readJsonOrNull,
    hashForLog,
  },
};
