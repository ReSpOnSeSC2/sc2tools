// @ts-check
/**
 * Tests for services/opponent_reconcile.js -- the post-game barcode
 * reconciliation cache.
 *
 * No mocks: the service is pure; the test injects its own
 * stripClanTag to exercise the option path.
 */

'use strict';

const {
  createReconcileService,
  defaultStripClanTag,
} = require('../services/opponent_reconcile');

describe('defaultStripClanTag', () => {
  test('strips bracket clan prefix', () => {
    expect(defaultStripClanTag('[CLAN]Yamada')).toBe('Yamada');
  });

  test('passes through bare names unchanged', () => {
    expect(defaultStripClanTag('Yamada')).toBe('Yamada');
  });

  test('handles whitespace inside the bracket', () => {
    expect(defaultStripClanTag('[CLAN] Yamada ')).toBe('Yamada');
  });

  test('returns empty string for non-string input', () => {
    expect(defaultStripClanTag(/** @type {any} */ (null))).toBe('');
    expect(defaultStripClanTag(/** @type {any} */ (undefined))).toBe('');
    expect(defaultStripClanTag(/** @type {any} */ (123))).toBe('');
  });
});

describe('createReconcileService.recordFromDeepPayload', () => {
  test('records a new pulse_id and returns null previousPulseId', () => {
    const svc = createReconcileService();
    const diff = svc.recordFromDeepPayload({
      oppName: 'Mirtillo',
      oppPulseId: '4298629',
      oppToon: '2-S2-1-9876543',
      oppRace: 'P',
    });
    expect(diff).not.toBeNull();
    expect(diff.oppName).toBe('Mirtillo');
    expect(diff.oppPulseId).toBe('4298629');
    expect(diff.previousPulseId).toBeNull();
    expect(diff.entry.pulseId).toBe('4298629');
    expect(diff.entry.oppToon).toBe('2-S2-1-9876543');
    expect(diff.entry.oppRace).toBe('P');
    expect(svc.size()).toBe(1);
  });

  test('second record under same name surfaces the prior pulse_id', () => {
    const svc = createReconcileService();
    svc.recordFromDeepPayload({ oppName: 'IIIIIIIIII', oppPulseId: '111111' });
    const diff = svc.recordFromDeepPayload({
      oppName: 'IIIIIIIIII',
      oppPulseId: '222222',
    });
    expect(diff.previousPulseId).toBe('111111');
    expect(diff.oppPulseId).toBe('222222');
    expect(svc.size()).toBe(1);
  });

  test('clan-tagged and bare names share the same cache row', () => {
    const svc = createReconcileService();
    svc.recordFromDeepPayload({
      oppName: '[CLAN]Yamada',
      oppPulseId: '340938838',
    });
    expect(svc.getReconciledPulseId('Yamada')).toBe('340938838');
    expect(svc.getReconciledPulseId('[OTHER]Yamada')).toBe('340938838');
  });

  test('missing oppPulseId is a no-op (no spurious diff)', () => {
    const svc = createReconcileService();
    const diff = svc.recordFromDeepPayload({ oppName: 'Yamada' });
    expect(diff).toBeNull();
    expect(svc.size()).toBe(0);
  });

  test('missing oppName is a no-op', () => {
    const svc = createReconcileService();
    const diff = svc.recordFromDeepPayload({ oppPulseId: '111111' });
    expect(diff).toBeNull();
    expect(svc.size()).toBe(0);
  });

  test('null payload returns null gracefully', () => {
    const svc = createReconcileService();
    expect(svc.recordFromDeepPayload(null)).toBeNull();
    expect(svc.recordFromDeepPayload(undefined)).toBeNull();
  });

  test('coerces numeric oppPulseId to a string for safe Socket.io emission', () => {
    const svc = createReconcileService();
    const diff = svc.recordFromDeepPayload({
      oppName: 'Yamada',
      oppPulseId: 340938838,
    });
    expect(diff.oppPulseId).toBe('340938838');
    expect(typeof diff.oppPulseId).toBe('string');
  });

  test('honours an injected stripClanTag implementation', () => {
    const svc = createReconcileService({
      stripClanTag: (n) => n.replace(/^@+/, ''),
    });
    svc.recordFromDeepPayload({ oppName: '@@Yamada', oppPulseId: 'X' });
    expect(svc.getReconciledPulseId('Yamada')).toBe('X');
    expect(svc.getReconciledPulseId('@@@Yamada')).toBe('X');
  });
});

describe('createReconcileService.getReconciledPulseId', () => {
  test('returns null for an unknown name', () => {
    const svc = createReconcileService();
    expect(svc.getReconciledPulseId('NoSuchPlayer')).toBeNull();
  });

  test('is case-insensitive', () => {
    const svc = createReconcileService();
    svc.recordFromDeepPayload({ oppName: 'Yamada', oppPulseId: 'Z' });
    expect(svc.getReconciledPulseId('yamada')).toBe('Z');
    expect(svc.getReconciledPulseId('YAMADA')).toBe('Z');
  });

  test('returns null for empty / non-string input', () => {
    const svc = createReconcileService();
    expect(svc.getReconciledPulseId('')).toBeNull();
    expect(svc.getReconciledPulseId(/** @type {any} */ (null))).toBeNull();
    expect(svc.getReconciledPulseId(/** @type {any} */ (123))).toBeNull();
  });
});

describe('createReconcileService.getReconciledEntry', () => {
  test('returns the full entry shape', () => {
    const svc = createReconcileService();
    svc.recordFromDeepPayload({
      oppName: 'Mirtillo',
      oppPulseId: '4298629',
      oppToon: '2-S2-1-1234',
      oppRace: 'P',
    });
    const entry = svc.getReconciledEntry('Mirtillo');
    expect(entry).not.toBeNull();
    expect(entry.pulseId).toBe('4298629');
    expect(entry.oppToon).toBe('2-S2-1-1234');
    expect(entry.oppRace).toBe('P');
    expect(typeof entry.updatedAt).toBe('number');
  });

  test('returns null for a name that was never recorded', () => {
    const svc = createReconcileService();
    expect(svc.getReconciledEntry('Mirtillo')).toBeNull();
  });
});

describe('createReconcileService.clear / size', () => {
  test('clear empties the cache', () => {
    const svc = createReconcileService();
    svc.recordFromDeepPayload({ oppName: 'Yamada', oppPulseId: '1' });
    svc.recordFromDeepPayload({ oppName: 'Mirtillo', oppPulseId: '2' });
    expect(svc.size()).toBe(2);
    svc.clear();
    expect(svc.size()).toBe(0);
    expect(svc.getReconciledPulseId('Yamada')).toBeNull();
  });
});
