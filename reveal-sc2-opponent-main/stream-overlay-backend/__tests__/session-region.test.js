/**
 * Tests for the v1.4.5 region-resolution helpers used by the session
 * widget's "SERVER + MMR" line (e.g., 'NA 4280').
 *
 * The original bug: SC2Pulse returns ch.region as either a numeric
 * code (1/2/3/5) OR a string enum ('US'/'EU'/'KR'/'CN'), and Pulse
 * uses 'US' for Americas while SC2 players say 'NA'. The session
 * widget showed '— 4280' (no server) when the string-shaped response
 * landed first because the old code only handled numeric codes.
 *
 * v1.4.5 added extractTeamRegionLabel() to normalize both shapes into
 * the short label the widget renders. These tests pin that contract.
 */

'use strict';

process.env.NODE_ENV = 'test';

const { extractTeamRegionLabel, pickActiveTeam } = require('../index');

describe('extractTeamRegionLabel (v1.4.5 region resolution)', () => {
    test('returns null for null/undefined team (preserves prior region)', () => {
        expect(extractTeamRegionLabel(null)).toBeNull();
        expect(extractTeamRegionLabel(undefined)).toBeNull();
    });

    test('returns null when members array is missing', () => {
        expect(extractTeamRegionLabel({})).toBeNull();
    });

    test('returns null when first member has no character', () => {
        expect(extractTeamRegionLabel({ members: [{}] })).toBeNull();
    });

    test('returns null when character.region is missing', () => {
        expect(extractTeamRegionLabel({
            members: [{ character: { name: 'Foo' } }]
        })).toBeNull();
    });

    test('maps numeric Pulse region codes to short labels', () => {
        const mk = (r) => ({ members: [{ character: { region: r } }] });
        expect(extractTeamRegionLabel(mk(1))).toBe('NA');
        expect(extractTeamRegionLabel(mk(2))).toBe('EU');
        expect(extractTeamRegionLabel(mk(3))).toBe('KR');
        expect(extractTeamRegionLabel(mk(5))).toBe('CN');
    });

    test('returns null for an unknown numeric region (no clobber)', () => {
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 99 } }]
        })).toBeNull();
    });

    test('maps string Pulse region enums to short labels', () => {
        const mk = (r) => ({ members: [{ character: { region: r } }] });
        expect(extractTeamRegionLabel(mk('US'))).toBe('NA');
        expect(extractTeamRegionLabel(mk('EU'))).toBe('EU');
        expect(extractTeamRegionLabel(mk('KR'))).toBe('KR');
        expect(extractTeamRegionLabel(mk('CN'))).toBe('CN');
    });

    test("normalizes 'US' to 'NA' to match SC2 player convention", () => {
        // Pulse stores Americas as 'US' but SC2 players (and the widget)
        // call it 'NA'. The widget's renderSessionMmr concatenates this
        // label directly: bad input here = 'US 4280' instead of 'NA 4280'.
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 'US' } }]
        })).toBe('NA');
    });

    test('accepts already-short labels (NA) idempotently', () => {
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 'NA' } }]
        })).toBe('NA');
    });

    test('is case-insensitive on string region', () => {
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 'us' } }]
        })).toBe('NA');
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 'eu' } }]
        })).toBe('EU');
    });

    test('returns null for an unknown string region (no clobber)', () => {
        expect(extractTeamRegionLabel({
            members: [{ character: { region: 'XX' } }]
        })).toBeNull();
    });
});

describe('pickActiveTeam (multi-region recency selection)', () => {
    test('returns null for empty/missing teams', () => {
        expect(pickActiveTeam(null)).toBeNull();
        expect(pickActiveTeam([])).toBeNull();
    });

    test('skips teams with non-finite rating', () => {
        const teams = [{ rating: 'bogus', lastPlayed: '2026-05-01T00:00:00Z' }];
        expect(pickActiveTeam(teams)).toBeNull();
    });

    test('picks the team with the most recent lastPlayed', () => {
        // Multi-region streamer just switched NA -> EU. The EU team's
        // lastPlayed moves forward and the session widget should follow.
        const naTeam = {
            rating: 4100,
            lastPlayed: '2026-05-01T10:00:00Z',
            members: [{ character: { region: 1, name: 'me' } }]
        };
        const euTeam = {
            rating: 3900,
            lastPlayed: '2026-05-02T11:00:00Z',
            members: [{ character: { region: 2, name: 'me' } }]
        };
        const picked = pickActiveTeam([naTeam, euTeam]);
        expect(picked).not.toBeNull();
        expect(picked.rating).toBe(3900);
        expect(picked.raw).toBe(euTeam);
    });

    test('on lastPlayed tie, picks the higher-rated team', () => {
        const ts = '2026-05-02T11:00:00Z';
        const lo = { rating: 3500, lastPlayed: ts, members: [{}] };
        const hi = { rating: 4200, lastPlayed: ts, members: [{}] };
        const picked = pickActiveTeam([lo, hi]);
        expect(picked.rating).toBe(4200);
    });

    test('rounds non-integer Pulse ratings to int', () => {
        const team = {
            rating: 4280.6,
            lastPlayed: '2026-05-02T11:00:00Z',
            members: [{}]
        };
        expect(pickActiveTeam([team]).rating).toBe(4281);
    });
});

describe('pickActiveTeam (v1.4.7 preferredRegion override)', () => {
    // v1.4.7 fix: when the user has multiple teams across regions and
    // Pulse hasn't ingested the just-played game yet, the OLD region's
    // team can have a more-recent lastPlayed than the NEW region's team,
    // causing pickActiveTeam to keep selecting the wrong account after a
    // region switch. The deep parse's opp-pulse-id-to-region lookup gives
    // us a reliable hint: in 1v1 ranked the user is on the same region as
    // the opponent. pickActiveTeam now accepts a preferredRegion arg that
    // filters the candidate set before the recency tie-break.
    const naTeamFresh = {
        rating: 5382,
        lastPlayed: '2026-05-02T06:00:00Z',
        members: [{ character: { region: 'US', name: 'NaAlt' } }]
    };
    const euTeamStale = {
        rating: 4100,
        lastPlayed: '2026-05-01T12:00:00Z',
        members: [{ character: { region: 'EU', name: 'EuMain' } }]
    };

    test('without preference, picks most-recently-played (legacy behavior)', () => {
        const picked = pickActiveTeam([naTeamFresh, euTeamStale]);
        expect(picked.rating).toBe(5382);
    });

    test('with EU preference, picks the EU team even though it is staler', () => {
        const picked = pickActiveTeam([naTeamFresh, euTeamStale], 'EU');
        expect(picked).not.toBeNull();
        expect(picked.rating).toBe(4100);
        expect(picked.raw).toBe(euTeamStale);
    });

    test('with NA preference, picks the NA team', () => {
        const picked = pickActiveTeam([naTeamFresh, euTeamStale], 'NA');
        expect(picked.rating).toBe(5382);
        expect(picked.raw).toBe(naTeamFresh);
    });

    test('with preference matching no team, returns null (caller falls back)', () => {
        const picked = pickActiveTeam([naTeamFresh, euTeamStale], 'KR');
        expect(picked).toBeNull();
    });

    test('numeric region codes filter the same way as string codes', () => {
        const numericNa = {
            rating: 5000,
            lastPlayed: '2026-05-02T10:00:00Z',
            members: [{ character: { region: 1 } }]
        };
        const numericEu = {
            rating: 4500,
            lastPlayed: '2026-05-02T09:00:00Z',
            members: [{ character: { region: 2 } }]
        };
        expect(pickActiveTeam([numericNa, numericEu], 'EU').rating).toBe(4500);
        expect(pickActiveTeam([numericNa, numericEu], 'NA').rating).toBe(5000);
    });
});
