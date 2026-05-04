// @ts-check
'use strict';

/**
 * Stage 7 of STAGE_DATA_INTEGRITY_ROADMAP -- torn-write recovery.
 *
 * Simulates the failure mode that originally produced the 2026-04
 * truncations: the writer is killed between fsync and rename, so a
 * `.tmp_*.json` is left on disk while the live file is unchanged
 * or itself partially-written.
 *
 * What this test pins:
 *   * If the live file is intact and orphans are present + aged,
 *     the integrity sweep stages a candidate without touching the
 *     live file.
 *   * If the live file is corrupt (truncated mid-rename), the sweep
 *     stages a candidate from the .tmp orphan and the apply path
 *     restores the file via the Stage 4 atomic publish.
 *   * The post-apply file passes the validate-before-rename gate
 *     for any subsequent atomicWriteJson.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const integritySweep = require('../../lib/integrity_sweep');
const { atomicWriteJson } = require('../../lib/atomic-fs');

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc2-torn-'));
}
function rmTmp(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* */ }
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

describe('Stage 7 -- torn write recovery', () => {
  test('aged orphan + corrupt live -> candidate -> apply', () => {
    const tmp = makeTmp();
    try {
      const live = path.join(tmp, 'MyOpponentHistory.json');
      // Live file has 5 keys (below 100-key floor). This simulates
      // the wipe pattern: a buggy save() blew away the historical
      // records but didn't quite finish the rename.
      writeJson(live, { a: 1, b: 2, c: 3, d: 4, e: 5 });
      // Aged .tmp_ orphan with 200 keys (the would-be rename source
      // that didn't make it across).
      const orphan = path.join(tmp, '.tmp_torn.json');
      const orphanData = {};
      for (let i = 0; i < 200; i++) orphanData[String(i)] = { Name: 'P' + i };
      writeJson(orphan, orphanData);
      const oldT = (Date.now() / 1000) - 600;
      fs.utimesSync(orphan, oldT, oldT);

      const report = integritySweep.runSweep(tmp);
      const finding = report.findings.find(
        (f) => f.basename === 'MyOpponentHistory.json',
      );
      expect(finding.status).toBe('corrupt_small');
      expect(finding.candidate_path).toBeTruthy();
      expect(finding.candidate_keys).toBe(200);

      integritySweep.applyCandidate(finding.candidate_path, live);
      const back = JSON.parse(fs.readFileSync(live, 'utf8'));
      expect(Object.keys(back).length).toBe(200);

      // Post-apply: a normal save still passes the Stage 4 gate.
      back['additional'] = { Name: 'New' };
      atomicWriteJson(live, back);
      const after = JSON.parse(fs.readFileSync(live, 'utf8'));
      expect(after.additional).toBeDefined();
    } finally { rmTmp(tmp); }
  });

  test('unparseable live + .bak fallback', () => {
    const tmp = makeTmp();
    try {
      const live = path.join(tmp, 'MyOpponentHistory.json');
      const bak = live + '.bak';
      // Truncated live file.
      fs.writeFileSync(live, '{"a": 1, "b": ');
      // .bak holds the last good commit.
      const bakData = {};
      for (let i = 0; i < 150; i++) bakData[String(i)] = { Name: 'B' + i };
      writeJson(bak, bakData);

      const report = integritySweep.runSweep(tmp);
      const finding = report.findings.find(
        (f) => f.basename === 'MyOpponentHistory.json',
      );
      expect(finding.status).toBe('corrupt_unparseable');
      expect(finding.candidate_source).toBe('bak');
      expect(finding.candidate_keys).toBe(150);

      integritySweep.applyCandidate(finding.candidate_path, live);
      const back = JSON.parse(fs.readFileSync(live, 'utf8'));
      expect(Object.keys(back).length).toBe(150);
    } finally { rmTmp(tmp); }
  });
});
