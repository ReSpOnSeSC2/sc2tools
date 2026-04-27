const { mmrToLeague } = require('./utils');

describe('mmrToLeague', () => {
    test('handles standard valid MMR values', () => {
        expect(mmrToLeague(5500)).toBe('Grandmaster');
        expect(mmrToLeague(5000)).toBe('Grandmaster');
        expect(mmrToLeague(4999)).toBe('Master');
        expect(mmrToLeague(4400)).toBe('Master');
        expect(mmrToLeague(4399)).toBe('Diamond');
        expect(mmrToLeague(3500)).toBe('Diamond');
        expect(mmrToLeague(3499)).toBe('Platinum');
        expect(mmrToLeague(2800)).toBe('Platinum');
        expect(mmrToLeague(2799)).toBe('Gold');
        expect(mmrToLeague(2200)).toBe('Gold');
        expect(mmrToLeague(2199)).toBe('Silver');
        expect(mmrToLeague(1700)).toBe('Silver');
        expect(mmrToLeague(1699)).toBe('Bronze');
        expect(mmrToLeague(100)).toBe('Bronze');
        expect(mmrToLeague(0)).toBe('Bronze');
    });

    test('handles invalid inputs gracefully', () => {
        expect(mmrToLeague(NaN)).toBeNull();
        expect(mmrToLeague(Infinity)).toBeNull();
        expect(mmrToLeague(-Infinity)).toBeNull();
        expect(mmrToLeague(undefined)).toBeNull();
        expect(mmrToLeague(null)).toBeNull();
        expect(mmrToLeague('3000')).toBeNull(); // Requires numeric input
    });

    test('handles out-of-bounds low MMR values', () => {
        expect(mmrToLeague(-1)).toBeNull();
        expect(mmrToLeague(-100)).toBeNull();
    });
});
