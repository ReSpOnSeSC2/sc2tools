const fs = require('fs');
const indexModule = require('./index');

describe('loadSession', () => {
    let originalConsoleError;
    let originalConsoleLog;

    beforeEach(() => {
        originalConsoleError = console.error;
        originalConsoleLog = console.log;
        console.error = jest.fn();
        console.log = jest.fn();
    });

    afterEach(() => {
        console.error = originalConsoleError;
        console.log = originalConsoleLog;
        if (fs.existsSync(indexModule.SESSION_STATE_PATH)) {
            fs.unlinkSync(indexModule.SESSION_STATE_PATH);
        }
    });

    test('returns defaultSession if file does not exist', () => {
        if (fs.existsSync(indexModule.SESSION_STATE_PATH)) {
            fs.unlinkSync(indexModule.SESSION_STATE_PATH);
        }
        const session = indexModule.loadSession();
        const expected = indexModule.defaultSession();
        // Ignoring startedAt difference
        expect(session.wins).toBe(expected.wins);
        expect(session.losses).toBe(expected.losses);
        expect(session.mmrStart).toBe(expected.mmrStart);
    });

    test('catches error and returns defaultSession if file is unreadable (invalid JSON)', () => {
        fs.writeFileSync(indexModule.SESSION_STATE_PATH, 'invalid json {[');

        const session = indexModule.loadSession();
        const expected = indexModule.defaultSession();

        expect(session.wins).toBe(expected.wins);
        expect(session.losses).toBe(expected.losses);
        expect(session.mmrStart).toBe(expected.mmrStart);
    });

    test('loads and returns valid session data merged with defaults', () => {
        const validData = {
            wins: 5,
            losses: 2,
            mmrStart: 3000,
            mmrCurrent: 3050,
            lastResultTime: Date.now()
        };
        fs.writeFileSync(indexModule.SESSION_STATE_PATH, JSON.stringify(validData));

        const session = indexModule.loadSession();

        expect(session.wins).toBe(5);
        expect(session.losses).toBe(2);
        expect(session.mmrStart).toBe(3000);
        expect(session.mmrCurrent).toBe(3050);
        expect(session.mmrDelta).toBe(50); // Since it was 0, it gets backfilled based on current-start
    });

    test('starts fresh session if idle gap is exceeded', () => {
        jest.useFakeTimers();
        const oldData = {
            wins: 10,
            losses: 10,
            lastResultTime: Date.now() - (2 * 60 * 60 * 1000) // 2 hours ago
        };
        fs.writeFileSync(indexModule.SESSION_STATE_PATH, JSON.stringify(oldData));

        const session = indexModule.loadSession();

        expect(console.log).toHaveBeenCalledWith('[Session] Idle gap exceeded, starting fresh session.');
        expect(session.wins).toBe(0);
        expect(session.losses).toBe(0);

        jest.useRealTimers();
    });
});
