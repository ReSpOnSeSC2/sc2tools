/**
 * Tests for services/community_sync.js (Stage 7.3 + 11.3).
 *
 * The service is deliberately pure -- no Express, no Socket.io. Tests
 * inject a tmp dataDir and a fake fetch, then exercise the public API:
 *
 *   createCommunitySyncService({ dataDir, fetchImpl, ... })
 *     .getStatus / .getClientId / .getBaseUrl
 *     .queueUpsert / .queueDelete / .queueVote
 *     .syncNow / .start / .stop
 *     .readQueue / .readCache
 *
 * Plus the small pure helpers exposed via __test__:
 *   - toRemote / fromRemote round-trip
 *   - backoffFor exponential math + cap
 *   - signBody HMAC determinism + isolation by pepper
 *
 * No real network, no real disk outside the per-test tmp dir.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  createCommunitySyncService, __test__,
} = require('../services/community_sync');
const {
  makeTmpDir, rmTmpDir, makeFakeFetch, jsonResponse,
} = require('./_helpers');

const TEST_BASE_URL = 'http://community.test.invalid';

function buildService(extra) {
  const dataDir = makeTmpDir('sc2-csync-');
  const ff = makeFakeFetch();
  const service = createCommunitySyncService(Object.assign({
    dataDir,
    baseUrl: TEST_BASE_URL,
    fetchImpl: ff.fetch,
  }, extra || {}));
  return { service, dataDir, fakeFetch: ff };
}

function sampleLocalBuild() {
  return {
    id: 'b-001',
    name: 'Cannon Rush',
    race: 'P',
    vs_race: 'Z',
    tier: 'A',
    description: 'opener',
    win_conditions: ['fast cannons'],
    loses_to: ['drone scout'],
    transitions_into: ['blink stalker'],
    signature: [{ t: 60, what: 'forge', weight: 1 }],
    tolerance_sec: 30,
    min_match_score: 0.6,
    author: 'TesterBT',
  };
}

describe('factory contract', () => {
  test('throws when dataDir does not exist', () => {
    expect(() => createCommunitySyncService({
      dataDir: '/no/such/path/__sc2_csync__',
      fetchImpl: () => Promise.resolve(jsonResponse()),
    })).toThrow(/dataDir/);
  });

  test('exposes baseUrl + a stable client id', () => {
    const h = buildService();
    try {
      expect(h.service.getBaseUrl()).toBe(TEST_BASE_URL);
      const id1 = h.service.getClientId();
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThanOrEqual(32);
      // Calling again returns the same persisted client id.
      expect(h.service.getClientId()).toBe(id1);
    } finally {
      rmTmpDir(h.dataDir);
    }
  });
});

describe('queue persistence', () => {
  let h;
  beforeEach(() => { h = buildService(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('queueUpsert appends a kind:upsert entry persisted to disk', () => {
    h.service.queueUpsert(sampleLocalBuild());
    const queueFile = path.join(h.dataDir, 'community_sync_queue.json');
    expect(fs.existsSync(queueFile)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    expect(onDisk.entries).toHaveLength(1);
    expect(onDisk.entries[0].kind).toBe('upsert');
    expect(onDisk.entries[0].build.id).toBe('b-001');
  });

  test('queueDelete + queueVote each append the right kind', () => {
    h.service.queueDelete('b-002');
    h.service.queueVote('b-003', 'up');
    const q = h.service.readQueue();
    expect(q.entries.map((e) => e.kind)).toEqual(['delete', 'vote']);
    expect(q.entries[1].vote).toBe('up');
  });

  test('readQueue returns the empty shape when no file exists', () => {
    const q = h.service.readQueue();
    expect(q.entries).toEqual([]);
  });

  test('atomic-write hygiene: no leftover .tmp file', () => {
    h.service.queueUpsert(sampleLocalBuild());
    expect(fs.existsSync(path.join(h.dataDir, 'community_sync_queue.json.tmp'))).toBe(false);
  });
});

describe('readCache', () => {
  let h;
  beforeEach(() => { h = buildService(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('returns the empty-shape envelope when cache file is missing', () => {
    const cache = h.service.readCache();
    expect(cache).toEqual({ version: 2, last_sync_at: null, server_now: 0, builds: [] });
  });

  test('returns parsed JSON when cache file exists', () => {
    const cachePath = path.join(h.dataDir, 'community_builds.cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({ builds: [{ id: 'x' }] }));
    expect(h.service.readCache()).toEqual({ builds: [{ id: 'x' }] });
  });
});

describe('getStatus', () => {
  let h;
  beforeEach(() => { h = buildService(); });
  afterEach(() => rmTmpDir(h.dataDir));

  test('reports pending count after queueing entries', () => {
    h.service.queueUpsert(sampleLocalBuild());
    h.service.queueUpsert({ ...sampleLocalBuild(), id: 'b-002' });
    const status = h.service.getStatus();
    expect(status.pending_count).toBeGreaterThanOrEqual(2);
    expect(status.client_id).toBe(h.service.getClientId());
    expect(status.in_flight).toBe(false);
    expect(typeof status.cache_count).toBe('number');
  });
});

describe('toRemote / fromRemote round-trip', () => {
  test('local -> remote -> local preserves the canonical fields', () => {
    const local = sampleLocalBuild();
    const remote = __test__.toRemote(local, 'client-id-abc');
    expect(remote.vsRace).toBe('Z');
    expect(remote.authorClientId).toBe('client-id-abc');
    expect(remote.signature[0].weight).toBe(1);

    // Remote shape mirrors what the API would echo back, plus a few
    // extra server-controlled fields.
    const echoed = Object.assign({}, remote, {
      createdAt: 1714000000000,
      updatedAt: 1714000060000,
      version: 2,
      upvotes: 7,
      downvotes: 1,
    });
    const back = __test__.fromRemote(echoed);
    expect(back.id).toBe(local.id);
    expect(back.vs_race).toBe('Z');
    expect(back.upvotes).toBe(7);
    expect(back.sync_state).toBe('synced');
    expect(back.signature[0].what).toBe('forge');
  });
});

describe('signBody HMAC', () => {
  test('is deterministic for the same pepper + body', () => {
    const a = __test__.signBody('00'.repeat(32), '{"a":1}');
    const b = __test__.signBody('00'.repeat(32), '{"a":1}');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('differs when pepper differs', () => {
    const a = __test__.signBody('00'.repeat(32), '{"a":1}');
    const b = __test__.signBody('11'.repeat(32), '{"a":1}');
    expect(a).not.toBe(b);
  });

  test('differs when body differs', () => {
    const a = __test__.signBody('00'.repeat(32), '{"a":1}');
    const b = __test__.signBody('00'.repeat(32), '{"a":2}');
    expect(a).not.toBe(b);
  });
});

describe('backoffFor', () => {
  test('30s for the first attempt', () => {
    expect(__test__.backoffFor(1)).toBe(30 * 1000);
  });
  test('60s for the second attempt (exponential)', () => {
    expect(__test__.backoffFor(2)).toBe(60 * 1000);
  });
  test('caps at 1 hour for very high attempt counts', () => {
    expect(__test__.backoffFor(50)).toBe(60 * 60 * 1000);
  });
  test('non-positive attempts collapse to base', () => {
    expect(__test__.backoffFor(0)).toBe(30 * 1000);
    expect(__test__.backoffFor(-3)).toBe(30 * 1000);
  });
});

describe('hashForLog', () => {
  test('returns 8 hex chars for any non-empty string', () => {
    const out = __test__.hashForLog('opponent-battle-tag#1234');
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });
  test('returns empty string for empty input (PII-safe contract)', () => {
    expect(__test__.hashForLog('')).toBe('');
    expect(__test__.hashForLog(null)).toBe('');
    expect(__test__.hashForLog(undefined)).toBe('');
  });
});
