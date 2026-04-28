/**
 * Regression test for `analyzer.salvageJsonObject` in analyzer.js.
 *
 * The old implementation pushed `m.index + 1` (the position of the
 * trailing `,`) and sliced `raw.slice(0, cut + 1)`, producing
 * `...},\n}\n` which is invalid JSON. Every salvaged candidate failed
 * to parse, so a partial-write of MyOpponentHistory.json couldn't be
 * recovered and dbCache.opp.data remained stale — the surface symptom
 * was the Opponents tab missing recent games against opponents whose
 * record sat near the truncation point.
 */

'use strict';

// Read the salvage function out of analyzer.js without invoking the
// rest of the module's global side effects (file watchers, route
// registration, etc.). The function is self-contained so we eval it
// against an empty sandbox.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ANALYZER_PATH = path.join(__dirname, '..', 'analyzer.js');
const src = fs.readFileSync(ANALYZER_PATH, 'utf8');
const start = src.indexOf('function salvageJsonObject(');
const end = src.indexOf('\nfunction readJsonStripBom(');
if (start < 0 || end < 0) {
    throw new Error('salvageJsonObject not found in analyzer.js');
}
const fnSrc = src.slice(start, end);
const sandbox = {};
vm.runInNewContext(fnSrc + '\nsandbox.fn = salvageJsonObject;', { sandbox });
const salvageJsonObject = sandbox.fn;

describe('analyzer.salvageJsonObject', () => {
    test('recovers from a mid-record truncation', () => {
        // A typical truncated MyOpponentHistory.json: well-formed for
        // the first two records, then cut off mid-string in the third.
        const raw = [
            '{',
            '    "12345": {',
            '        "Name": "Alice",',
            '        "Race": "Z",',
            '        "Notes": ""',
            '    },',
            '    "67890": {',
            '        "Name": "Bob",',
            '        "Race": "P",',
            '        "Notes": ""',
            '    },',
            '    "incomplete": {',
            '        "Name": "Truncate',
        ].join('\n');

        const out = salvageJsonObject(raw);
        expect(out).not.toBeNull();
        expect(Object.keys(out).sort()).toEqual(['12345', '67890']);
        expect(out['12345'].Name).toBe('Alice');
        expect(out['67890'].Name).toBe('Bob');
    });

    test('recovers from an unclosed outer dict (already comma-terminated)', () => {
        const raw = [
            '{',
            '    "a": { "Name": "A" },',
            '    "b": { "Name": "B" },',
        ].join('\n') + '\n';

        const out = salvageJsonObject(raw);
        expect(out).not.toBeNull();
        expect(out.a.Name).toBe('A');
        expect(out.b.Name).toBe('B');
    });

    test('returns null when no record boundary exists', () => {
        const raw = '{ "no boundary at all"';
        const out = salvageJsonObject(raw);
        expect(out).toBeNull();
    });

    test('drops the truncated tail and recovers all earlier records', () => {
        const raw = [
            '{',
            '    "a": { "Name": "A", "Matchups": {} },',
            '    "b": { "Name": "B", "Matchups": {} },',
            '    "c": { "Name": "C", "Matchups": { "PvP": { "Wins": 1, "Losses": 0, "Games": [',
        ].join('\n');
        const out = salvageJsonObject(raw);
        expect(out).not.toBeNull();
        expect(Object.keys(out).sort()).toEqual(['a', 'b']);
    });
});
