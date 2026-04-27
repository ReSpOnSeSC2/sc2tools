/**
 * Smoke tests for routes/onboarding.js.
 *
 * Wires the real router against an Express + supertest harness, with a
 * fake Python helper script that returns canned JSON, a stub fetch fn
 * for outbound HTTP, and a tmp ws server for OBS handshake testing.
 *
 * Per Stage 2.2 rules: NO MOCKS for shape-of-data. The fake helper is a
 * real Python file with real argparse; the stub fetch is a real
 * promise-returning function; the OBS test runs against a real ws
 * server we boot in-process.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const request = require('supertest');
const { WebSocketServer } = require('ws');

const {
  createOnboardingRouter,
  computeObsAuth,
  scanReplayFolders,
  parseIdentityOutput,
} = require('../routes/onboarding');

const TEST_PORT = 0; // Let the OS pick a free port for the OBS ws server.
const FAKE_TIMEOUT_GUARD_MS = 30_000; // jest-level safety net for ws tests.

function makeApp({ scriptsDir, repoRoot, fetchFn, loopbackBase }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(createOnboardingRouter({
    scriptsDir, repoRoot,
    pythonExe: process.platform === 'win32' ? 'py' : 'python3',
    fetch: fetchFn,
    loopbackBase: loopbackBase || (() => 'http://127.0.0.1:0'),
  }));
  return app;
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeIdentityCli(scriptsDir, payload, exitCode = 0) {
  const py = `import json, sys
sys.stdout.write(${JSON.stringify(JSON.stringify(payload))})
sys.stdout.write("\\n")
sys.exit(${exitCode})
`;
  fs.writeFileSync(path.join(scriptsDir, 'identity_cli.py'), py);
}

function fetchOk(body) {
  return async () => ({
    ok: true, status: 200, json: async () => body,
  });
}

function fetchErr(status, body) {
  return async () => ({
    ok: false, status, json: async () => body || {},
  });
}

// ===============================================================
// Pure-function exports
// ===============================================================

describe('parseIdentityOutput', () => {
  test('returns parsed object on a single-line JSON payload', () => {
    const out = parseIdentityOutput('{"ok":true,"players":[]}\n');
    expect(out).toEqual({ ok: true, players: [] });
  });
  test('returns null on empty input', () => {
    expect(parseIdentityOutput('')).toBeNull();
    expect(parseIdentityOutput('   \n')).toBeNull();
  });
  test('returns null on malformed JSON', () => {
    expect(parseIdentityOutput('garbage{')).toBeNull();
  });
});

describe('computeObsAuth', () => {
  test('matches the OBS WS v5 reference algorithm', () => {
    // Reference: secret = b64(sha256(password + salt))
    //            auth   = b64(sha256(secret + challenge))
    const password = 'hunter2';
    const salt = 'somesalt';
    const challenge = 'somechallenge';
    const secret = crypto.createHash('sha256')
        .update(password + salt).digest('base64');
    const expected = crypto.createHash('sha256')
        .update(secret + challenge).digest('base64');
    expect(computeObsAuth(password, salt, challenge)).toBe(expected);
  });
});

describe('scanReplayFolders', () => {
  test('returns an array (zero or more entries; never throws)', () => {
    const folders = scanReplayFolders();
    expect(Array.isArray(folders)).toBe(true);
    for (const f of folders) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.replay_count).toBe('number');
    }
  });
});

// ===============================================================
// HTTP endpoints
// ===============================================================

describe('POST /api/onboarding/scan-replay-folders', () => {
  test('returns ok:true with a folders array', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-scan-'),
      repoRoot: process.cwd(),
      fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/scan-replay-folders');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.folders)).toBe(true);
  });
});

describe('POST /api/onboarding/scan-identities', () => {
  test('returns the helper payload on the happy path', async () => {
    const scriptsDir = makeTmpDir('sc2-onb-id-');
    writeFakeIdentityCli(scriptsDir, {
      ok: true, scanned: 5, skipped: 0,
      players: [{ name: 'A', character_id: '1-S2-1-1', games_seen: 3 }],
    });
    const app = makeApp({
      scriptsDir, repoRoot: scriptsDir, fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/scan-identities')
      .send({ folder: scriptsDir, sample_size: 10 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.players[0].character_id).toBe('1-S2-1-1');
  });

  test('400s on missing folder', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-id2-'),
      repoRoot: process.cwd(), fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/scan-identities')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('500s when the helper is missing', async () => {
    const scriptsDir = makeTmpDir('sc2-onb-id3-');
    // No identity_cli.py written.
    const app = makeApp({
      scriptsDir, repoRoot: scriptsDir, fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/scan-identities')
      .send({ folder: scriptsDir });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });

  test('accepts folders[] (multi-folder)', async () => {
    const scriptsDir = makeTmpDir('sc2-onb-id4-');
    writeFakeIdentityCli(scriptsDir, {
      ok: true, scanned: 12, skipped: 0,
      folders: ['/a', '/b'],
      players: [
        { name: 'Multi', character_id: '1-S2-1-9', games_seen: 7 },
      ],
    });
    const app = makeApp({
      scriptsDir, repoRoot: scriptsDir, fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/scan-identities')
      .send({ folders: ['/a', '/b'], sample_size: 25 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.players[0].character_id).toBe('1-S2-1-9');
  });

  test('dedups overlapping folder + folders[]', async () => {
    const { normalizeFolderList } = require('../routes/onboarding');
    expect(normalizeFolderList({
      folder: '/a', folders: ['/a', '/b', '', null],
    })).toEqual(['/a', '/b']);
    expect(normalizeFolderList({})).toEqual([]);
  });
});

describe('POST /api/onboarding/test/twitch', () => {
  test('returns ok:true with login when the upstream is happy', async () => {
    const fetchFn = fetchOk({ data: [{ login: 'response', id: '42' }] });
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-tw-'),
      repoRoot: process.cwd(), fetchFn,
    });
    const res = await request(app)
      .post('/api/onboarding/test/twitch')
      .send({ channel: 'response', oauth_token: 'oauth:abc' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.login).toBe('response');
  });

  test('400s on missing oauth_token', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-tw2-'),
      repoRoot: process.cwd(), fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/test/twitch')
      .send({ channel: 'response' });
    expect(res.status).toBe(400);
  });

  test('502s when the upstream rejects the token', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-tw3-'),
      repoRoot: process.cwd(),
      fetchFn: fetchErr(401, { message: 'invalid token' }),
    });
    const res = await request(app)
      .post('/api/onboarding/test/twitch')
      .send({ oauth_token: 'oauth:bad' });
    expect(res.status).toBe(502);
  });
});

describe('POST /api/onboarding/test/pulse', () => {
  test('returns the character info on a Pulse hit (single)', async () => {
    // /character/{id} returns an array of one when the id exists.
    const fetchFn = fetchOk([{ name: 'Player#722', region: 'US', id: 11925845 }]);
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-pl-'),
      repoRoot: process.cwd(), fetchFn,
    });
    const res = await request(app)
      .post('/api/onboarding/test/pulse')
      .send({ character_id: '11925845' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].region).toBe('us');
    expect(res.body.results[0].name).toBe('Player');
  });

  test('accepts character_ids[] (multi)', async () => {
    const fetchFn = fetchOk([{ name: 'Player', region: 'US', id: 1 }]);
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-pl3-'),
      repoRoot: process.cwd(), fetchFn,
    });
    const res = await request(app)
      .post('/api/onboarding/test/pulse')
      .send({ character_ids: ['11925845', '8970077'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(2);
  });

  test('returns no_character on empty array (unknown id)', async () => {
    const fetchFn = fetchOk([]);
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-pl4-'),
      repoRoot: process.cwd(), fetchFn,
    });
    const res = await request(app)
      .post('/api/onboarding/test/pulse')
      .send({ character_id: '999999999' });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('pulse_no_character');
  });

  test('extracts character from every known envelope', () => {
    const { extractPulseCharacter } = require('../routes/onboarding');
    // Array of one (the /character/{id} endpoint).
    expect(extractPulseCharacter([{ id: 7, name: 'X' }]))
      .toEqual({ id: 7, name: 'X' });
    expect(extractPulseCharacter([])).toBeNull();
    // Array members.
    expect(extractPulseCharacter({
      members: [{ character: { id: 1, name: 'A' } }],
    })).toEqual({ id: 1, name: 'A' });
    // Object members (search payload).
    expect(extractPulseCharacter({
      members: { character: { id: 2, name: 'B' } },
    })).toEqual({ id: 2, name: 'B' });
    expect(extractPulseCharacter({ character: { id: 3 } })).toEqual({ id: 3 });
    expect(extractPulseCharacter({})).toBeNull();
    expect(extractPulseCharacter(null)).toBeNull();
  });

  test('400s on missing character_id', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-pl2-'),
      repoRoot: process.cwd(), fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/test/pulse')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/onboarding/test/obs', () => {
  // Boot a tiny ws server that speaks the obs-websocket v5 hello/identify
  // dance for one client, then closes. We start a fresh one per test so
  // they don't share port state.
  function startFakeObs({ requireAuth }) {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: TEST_PORT }, () => {
        resolve({ wss, port: wss.address().port });
      });
      const salt = 'salt-xyz';
      const challenge = 'chal-abc';
      wss.on('connection', (ws) => {
        const hello = {
          op: 0,
          d: {
            obsWebSocketVersion: '5.5.0',
            rpcVersion: 1,
            authentication: requireAuth ? { challenge, salt } : undefined,
          },
        };
        ws.send(JSON.stringify(hello));
        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString('utf8')); }
          catch (_e) { ws.close(); return; }
          if (msg.op !== 1) { ws.close(); return; }
          if (requireAuth) {
            const expected = computeObsAuth('hunter2', salt, challenge);
            if ((msg.d && msg.d.authentication) !== expected) {
              ws.close(); return;
            }
          }
          ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        });
      });
    });
  }

  test('completes the v5 handshake (no auth)',
       async () => {
    const { wss, port } = await startFakeObs({ requireAuth: false });
    try {
      const app = makeApp({
        scriptsDir: makeTmpDir('sc2-onb-obs-'),
        repoRoot: process.cwd(), fetchFn: fetchErr(503),
      });
      const res = await request(app)
        .post('/api/onboarding/test/obs')
        .send({ host: '127.0.0.1', port });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.version).toBe(1);
    } finally {
      await new Promise((r) => wss.close(r));
    }
  }, FAKE_TIMEOUT_GUARD_MS);

  test('completes the v5 handshake (with auth)',
       async () => {
    const { wss, port } = await startFakeObs({ requireAuth: true });
    try {
      const app = makeApp({
        scriptsDir: makeTmpDir('sc2-onb-obs2-'),
        repoRoot: process.cwd(), fetchFn: fetchErr(503),
      });
      const res = await request(app)
        .post('/api/onboarding/test/obs')
        .send({ host: '127.0.0.1', port, password: 'hunter2' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      await new Promise((r) => wss.close(r));
    }
  }, FAKE_TIMEOUT_GUARD_MS);

  test('reports obs_password_required when auth needed but missing',
       async () => {
    const { wss, port } = await startFakeObs({ requireAuth: true });
    try {
      const app = makeApp({
        scriptsDir: makeTmpDir('sc2-onb-obs3-'),
        repoRoot: process.cwd(), fetchFn: fetchErr(503),
      });
      const res = await request(app)
        .post('/api/onboarding/test/obs')
        .send({ host: '127.0.0.1', port });
      expect(res.status).toBe(502);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('obs_password_required');
    } finally {
      await new Promise((r) => wss.close(r));
    }
  }, FAKE_TIMEOUT_GUARD_MS);

  test('400s on missing port', async () => {
    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-obs4-'),
      repoRoot: process.cwd(), fetchFn: fetchErr(503),
    });
    const res = await request(app)
      .post('/api/onboarding/test/obs')
      .send({ host: '127.0.0.1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/onboarding/start-initial-backfill', () => {
  test('forwards to the analyzer backfill route and returns ok', async () => {
    // Spin up a tiny upstream that fakes the analyzer's response.
    const upstream = http.createServer((req, res) => {
      if (req.url === '/api/analyzer/macro/backfill/start'
          && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, started: true }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;

    const fetchFn = (url, init) => {
      // Use real http here for the test (the prod code uses a real fetch).
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
          host: u.hostname, port: u.port, path: u.pathname,
          method: init && init.method, headers: init && init.headers,
        }, (resp) => {
          let raw = '';
          resp.on('data', (c) => { raw += c; });
          resp.on('end', () => resolve({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            status: resp.statusCode,
            json: async () => JSON.parse(raw || '{}'),
          }));
        });
        req.on('error', reject);
        if (init && init.body) req.write(init.body);
        req.end();
      });
    };

    const app = makeApp({
      scriptsDir: makeTmpDir('sc2-onb-bk-'),
      repoRoot: process.cwd(),
      fetchFn,
      loopbackBase: () => `http://127.0.0.1:${upstreamPort}`,
    });
    try {
      const res = await request(app)
        .post('/api/onboarding/start-initial-backfill').send({});
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.started).toBe(true);
    } finally {
      await new Promise((r) => upstream.close(r));
    }
  });
});
