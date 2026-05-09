/**
 * Tests for POST /api/voice/diagnostics + GET /api/voice/diagnostics.
 *
 * The overlay's voice-readout.js posts here when TTS fails (autoplay
 * blocked, silent failure, speech-synthesis-engine error). The
 * dashboard reads the GET to surface a "your overlay's voice readout
 * is broken" warning rather than the streamer hearing nothing and
 * not knowing why.
 */

'use strict';

const path = require('path');

process.env.NODE_ENV = 'test';
process.env.SC2_META_DB_PATH = path.join(__dirname, '_helpers', '__nope__.json');
process.env.SC2_OPP_HISTORY_PATH = path.join(__dirname, '_helpers', '__nope__.json');

const request = require('supertest');
const indexExports = require('../index');

describe('POST /api/voice/diagnostics', () => {
  test('200 ok for a well-formed event report', async () => {
    const res = await request(indexExports.app)
      .post('/api/voice/diagnostics')
      .send({ event: 'tts_silent_failure', attempt: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('400 when the body is not an object', async () => {
    const res = await request(indexExports.app)
      .post('/api/voice/diagnostics')
      .send([{ event: 'tts_error', code: 'not-allowed' }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });
});

describe('GET /api/voice/diagnostics', () => {
  test('returns counts incremented per (event, code)', async () => {
    // Reset by iterating known events. We can't reset the in-process
    // counters from the test (they're module-private), so we just
    // assert that *at least* our additions show up after posting.
    const before = await request(indexExports.app).get('/api/voice/diagnostics');
    const beforeCounts = before.body.counts || {};

    await request(indexExports.app)
      .post('/api/voice/diagnostics')
      .send({ event: 'tts_error', code: 'synthesis-failed' });
    await request(indexExports.app)
      .post('/api/voice/diagnostics')
      .send({ event: 'tts_error', code: 'synthesis-failed' });
    await request(indexExports.app)
      .post('/api/voice/diagnostics')
      .send({ event: 'tts_blocked_gesture' });

    const res = await request(indexExports.app).get('/api/voice/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.counts['tts_error:synthesis-failed']
      - (beforeCounts['tts_error:synthesis-failed'] || 0)).toBe(2);
    expect(res.body.counts['tts_blocked_gesture:']
      - (beforeCounts['tts_blocked_gesture:'] || 0)).toBe(1);
    // lastSample echoes the most recent envelope the overlay sent.
    expect(res.body.lastSample.event).toBe('tts_blocked_gesture');
  });
});
