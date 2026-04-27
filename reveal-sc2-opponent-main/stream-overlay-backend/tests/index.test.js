const fs = require('fs');

// Mock out timers and fs.watchFile BEFORE importing index.js so it doesn't hang Jest
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  watchFile: jest.fn(),
  unwatchFile: jest.fn()
}));

jest.useFakeTimers();

const { describePulseTeam } = require('../index');

describe('describePulseTeam', () => {
    it('returns "?" for null or undefined', () => {
        expect(describePulseTeam(null)).toBe('?');
        expect(describePulseTeam(undefined)).toBe('?');
    });

    it('returns default formatting when fields are missing', () => {
        expect(describePulseTeam({})).toBe('R? ? (?)');
    });

    it('returns proper formatting for a complete team', () => {
        const team = {
            race: 'T',
            members: [{
                character: {
                    region: 1,
                    name: 'Player#123'
                }
            }]
        };
        expect(describePulseTeam(team)).toBe('NA Player (T)');
    });

    it('handles region fallback correctly', () => {
        const team = {
            race: 'Z',
            members: [{
                character: {
                    region: 99,
                    name: 'Zergling'
                }
            }]
        };
        expect(describePulseTeam(team)).toBe('R99 Zergling (Z)');
    });

    it('infers race from gamesPlayed if not provided in team', () => {
        const teamZ = { members: [{ character: { name: 'PlayerZ', region: 2 }, zergGamesPlayed: 10 }] };
        const teamP = { members: [{ character: { name: 'PlayerP', region: 3 }, protossGamesPlayed: 10 }] };
        const teamT = { members: [{ character: { name: 'PlayerT', region: 5 }, terranGamesPlayed: 10 }] };
        const teamR = { members: [{ character: { name: 'PlayerR', region: 1 }, randomGamesPlayed: 10 }] };

        expect(describePulseTeam(teamZ)).toBe('EU PlayerZ (Z)');
        expect(describePulseTeam(teamP)).toBe('KR PlayerP (P)');
        expect(describePulseTeam(teamT)).toBe('CN PlayerT (T)');
        expect(describePulseTeam(teamR)).toBe('NA PlayerR (R)');
    });
});
