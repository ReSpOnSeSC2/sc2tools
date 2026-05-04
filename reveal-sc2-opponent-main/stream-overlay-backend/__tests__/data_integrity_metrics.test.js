// @ts-check
'use strict';

/**
 * Stage 7 -- lib/data_integrity_metrics.js mirrors core/data_integrity_metrics.py
 * on counter names + snapshot shape.
 */

const metrics = require('../lib/data_integrity_metrics');

describe('Stage 7 -- counter increment', () => {
  beforeEach(() => { metrics._resetForTests(); });

  test('counters are namespaced by basename', () => {
    metrics.counterInc('write_attempted', { basename: 'MyOpponentHistory.json' });
    metrics.counterInc('write_attempted', { basename: 'MyOpponentHistory.json', n: 4 });
    metrics.counterInc('write_attempted', { basename: 'meta_database.json' });
    const snap = metrics.snapshot();
    expect(snap.counters.write_attempted['MyOpponentHistory.json']).toBe(5);
    expect(snap.counters.write_attempted['meta_database.json']).toBe(1);
  });

  test('unknown counter is dropped', () => {
    metrics.counterInc('definitely_not_a_real_counter');
    const snap = metrics.snapshot();
    expect(Object.keys(snap.counters)).toEqual([]);
  });
});

describe('Stage 7 -- histogram + errors', () => {
  beforeEach(() => { metrics._resetForTests(); });

  test('summary returns percentiles', () => {
    for (let v = 10; v <= 100; v += 10) {
      metrics.histogramRecord('write_duration_ms', v, { basename: 'x.json' });
    }
    const snap = metrics.snapshot();
    const sum = snap.histogram_summary['write_duration_ms:x.json'];
    expect(sum.count).toBe(10);
    expect(sum.p95).toBeGreaterThanOrEqual(90);
    expect(sum.min).toBe(10);
    expect(sum.max).toBe(100);
  });

  test('error ring buffer is bounded at 100', () => {
    for (let i = 0; i < 150; i++) {
      metrics.error('DataIntegrityError', { detail: { i } });
    }
    const snap = metrics.snapshot();
    expect(snap.recent_errors.length).toBeLessThanOrEqual(100);
    expect(snap.recent_errors[snap.recent_errors.length - 1].detail.i).toBe(149);
  });
});
