const { deepMerge } = require('../index.js');

describe('deepMerge', () => {
    it('should exist', () => {
        expect(typeof deepMerge).toBe('function');
    });

    it('should handle non-object inputs gracefully', () => {
        expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
        expect(deepMerge('string', { a: 1 })).toEqual({ a: 1 });
        expect(deepMerge(123, { a: 1 })).toEqual({ a: 1 });
    });

    it('should return base if override is null/undefined but keep base as fallback', () => {
        expect(deepMerge({ a: 1 }, null)).toEqual({ a: 1 });
        expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
    });

    it('should return override if base is null/array/primitive', () => {
        expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
        expect(deepMerge([], { a: 1 })).toEqual({ a: 1 });
        expect(deepMerge(1, { a: 1 })).toEqual({ a: 1 });
    });

    it('should return null or primitive if both are primitive/null', () => {
        expect(deepMerge(null, null)).toBe(null);
        expect(deepMerge([], undefined)).toEqual([]);
        expect(deepMerge(1, null)).toEqual(1);
    });

    it('should merge objects shallowly', () => {
        const base = { a: 1, b: 2 };
        const override = { b: 3, c: 4 };
        expect(deepMerge(base, override)).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('should merge objects deeply', () => {
        const base = {
            a: { x: 1, y: 2 },
            b: 2
        };
        const override = {
            a: { y: 3, z: 4 },
            c: 5
        };
        expect(deepMerge(base, override)).toEqual({
            a: { x: 1, y: 3, z: 4 },
            b: 2,
            c: 5
        });
    });

    it('should overwrite with primitive values in override (the bug fix)', () => {
        const base = { a: { x: 1 } };
        const override = { a: 2 };
        expect(deepMerge(base, override)).toEqual({ a: 2 });
    });

    it('should overwrite primitives with objects in override', () => {
        const base = { a: 1 };
        const override = { a: { x: 1 } };
        expect(deepMerge(base, override)).toEqual({ a: { x: 1 } });
    });

    it('should not mutate the base object', () => {
        const base = { a: { x: 1 } };
        const override = { a: { y: 2 } };
        const merged = deepMerge(base, override);

        expect(base).toEqual({ a: { x: 1 } });
        expect(merged).toEqual({ a: { x: 1, y: 2 } });
        expect(merged).not.toBe(base);
        expect(merged.a).not.toBe(base.a);
    });
});
