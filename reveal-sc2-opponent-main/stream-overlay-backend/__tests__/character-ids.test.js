/**
 * Tests for parsePublishedCharacterIdsText() -- the helper that reads
 * character_ids.txt and rejects corrupt entries that look like the
 * pre-fix PowerShell coercion bug.
 *
 * The original bug: Reveal-Sc2Opponent.ps1 declared the parameter as
 * [int64[]]$CharacterId. When invoked from a subprocess (Python
 * launcher path: scripts/poller_launch.py ->
 * core/launcher_config.build_poller_argv -> ",".join(ids)), PowerShell
 * received a single comma-joined string ("994428,8970877") and
 * silently coerced it via locale-aware int parsing (en-US comma ==
 * thousand separator), producing the single bogus int64
 * 9944288970877. That value was then written to character_ids.txt;
 * the Express backend read it back, asked SC2Pulse for teams under
 * that nonexistent ID, got nothing, and never called
 * applyPulseRating() -- leaving session.state.json with region=null
 * and the session widget's SERVER + MMR line stuck on '--'.
 *
 * v1.4.7 fixes the PS coercion at the source AND adds a defensive
 * sanity check on the file reader so legacy corrupt files (left over
 * from before users upgrade) don't silently break Pulse init.
 */

'use strict';

process.env.NODE_ENV = 'test';

const {
    parsePublishedCharacterIdsText,
    PULSE_ID_MAX
} = require('../index');

describe('parsePublishedCharacterIdsText (v1.4.7)', () => {
    test('returns [] for null/undefined/empty input', () => {
        expect(parsePublishedCharacterIdsText(null)).toEqual([]);
        expect(parsePublishedCharacterIdsText(undefined)).toEqual([]);
        expect(parsePublishedCharacterIdsText('')).toEqual([]);
        expect(parsePublishedCharacterIdsText('   ')).toEqual([]);
    });

    test('parses a single valid id', () => {
        expect(parsePublishedCharacterIdsText('994428')).toEqual([994428]);
    });

    test('parses comma-separated ids (the canonical multi-region case)', () => {
        // Two-region streamer: 994428 on NA, 8970877 on EU. The PS
        // script writes them comma-joined; this is exactly what the
        // original buggy run was supposed to produce after the fix.
        expect(parsePublishedCharacterIdsText('994428,8970877'))
            .toEqual([994428, 8970877]);
    });

    test('strips a UTF-8 BOM', () => {
        // PowerShell's `Out-File -Encoding ascii` can occasionally
        // sneak a BOM in via downstream tooling. The reader has always
        // stripped it; pinning that behavior here.
        const bom = '﻿';
        expect(parsePublishedCharacterIdsText(bom + '994428,8970877'))
            .toEqual([994428, 8970877]);
    });

    test('trims whitespace around individual ids', () => {
        expect(parsePublishedCharacterIdsText('  994428 , 8970877  '))
            .toEqual([994428, 8970877]);
    });

    test('drops trailing newline (tolerates Out-File default)', () => {
        expect(parsePublishedCharacterIdsText('994428,8970877\r\n'))
            .toEqual([994428, 8970877]);
    });

    test('skips non-numeric entries without breaking the array', () => {
        expect(parsePublishedCharacterIdsText('994428,not-a-number,8970877'))
            .toEqual([994428, 8970877]);
    });

    test('REJECTS the entire file when a corrupt mega-id is present', () => {
        // The exact failure mode: 994428 + 8970877 concatenated.
        // Mixing one bad ID with one good ID is still wrong because the
        // launcher always emits a coherent set, so the safest action
        // is to ignore the file and fall through to the wizard config.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(parsePublishedCharacterIdsText('9944288970877')).toEqual([]);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const msg = warnSpy.mock.calls[0][0];
            expect(msg).toMatch(/corrupt entries/);
            expect(msg).toMatch(/9944288970877/);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('REJECTS the file even if a good id is mixed in with a bad one', () => {
        // Defensive: any single corrupt id poisons the whole batch.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(parsePublishedCharacterIdsText('994428,9944288970877'))
                .toEqual([]);
            expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
            warnSpy.mockRestore();
        }
    });

    test('PULSE_ID_MAX cutoff is 1e9 (10 digits)', () => {
        // Pin the constant so a future "let's bump this to 1e12" PR
        // gets a failing test forcing the author to think about it.
        expect(PULSE_ID_MAX).toBe(1_000_000_000);
        // An id at the boundary is rejected.
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(parsePublishedCharacterIdsText('1000000000')).toEqual([]);
        } finally {
            warnSpy.mockRestore();
        }
        // An id one below the boundary is accepted.
        expect(parsePublishedCharacterIdsText('999999999')).toEqual([999999999]);
    });

    test('coerces a number arg to string before parsing', () => {
        // Defensive: callers shouldn't pass numbers, but if they do
        // (e.g. JS passes the int directly), we don't blow up.
        expect(parsePublishedCharacterIdsText(994428)).toEqual([994428]);
    });
});
