const { lookup, CATALOG } = require('../sc2_catalog');

describe('sc2_catalog lookup function', () => {
    test('returns null for empty or null input', () => {
        expect(lookup(null)).toBeNull();
        expect(lookup(undefined)).toBeNull();
        expect(lookup('')).toBeNull();
    });

    test('finds exact matches in CATALOG', () => {
        expect(lookup('Zealot')).toEqual(CATALOG['Zealot']);
        expect(lookup('Marine')).toEqual(CATALOG['Marine']);
        expect(lookup('Zergling')).toEqual(CATALOG['Zergling']);
        expect(lookup('Hatchery')).toEqual(CATALOG['Hatchery']);

        // Assert that we actually found something
        expect(lookup('Zealot')).not.toBeNull();
    });

    test('strips race prefix to find matches', () => {
        expect(lookup('ProtossZealot')).toEqual(CATALOG['Zealot']);
        expect(lookup('TerranMarine')).toEqual(CATALOG['Marine']);
        expect(lookup('ZergZergling')).toEqual(CATALOG['Zergling']);
        expect(lookup('ZergHatchery')).toEqual(CATALOG['Hatchery']);

        expect(lookup('ProtossZealot')).not.toBeNull();
    });

    test('returns null for unknown entities', () => {
        expect(lookup('UnknownUnit123')).toBeNull();
        expect(lookup('ProtossUnknownUnit123')).toBeNull();
        expect(lookup('Terran')).toBeNull();
    });
});
