const fs = require('fs');

jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
        writeFileSync: jest.fn(),
        renameSync: jest.fn(),
        mkdirSync: jest.fn(),
        watchFile: jest.fn(),
    };
});
jest.mock('express', () => {
    const app = {
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
    };
    const router = {
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
    };
    const express = jest.fn(() => app);
    express.json = jest.fn();
    express.static = jest.fn();
    express.Router = jest.fn(() => router);
    return express;
});
jest.mock('http', () => ({
    createServer: jest.fn(() => ({
        listen: jest.fn(),
    }))
}));
jest.mock('socket.io', () => {
    return {
        Server: jest.fn(() => ({
            emit: jest.fn(),
            on: jest.fn(),
        }))
    };
});
jest.mock('tmi.js', () => ({
    Client: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(),
        on: jest.fn(),
    }))
}));
jest.mock('./analyzer', () => ({
    router: {},
    startWatching: jest.fn()
}));
// loadConfig() lives early in index.js. Stub the heavyweight wiring
// that index.js spins up at module load (community sync writes
// client-id lock files to disk; the test harness has no such fs).
jest.mock('./services/community_sync', () => ({
    createCommunitySyncService: jest.fn(() => ({
        start: jest.fn(),
        stop: jest.fn(),
        syncNow: jest.fn().mockResolvedValue({}),
        queueUpsert: jest.fn(),
        queueDelete: jest.fn(),
        queueVote: jest.fn(),
        readQueue: jest.fn(() => ({ entries: [] })),
        getStatus: jest.fn(() => ({})),
    })),
}));
jest.mock('./services/opponent_reconcile', () => ({
    createReconcileService: jest.fn(() => ({
        start: jest.fn(),
        stop: jest.fn(),
    })),
}));

describe('loadConfig', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        process.env.NODE_ENV = 'test';
    });

    it('should use DEFAULT_CONFIG when fs.readFileSync throws an error', () => {
        const realFs = jest.requireActual('fs');
        const mockedFs = require('fs');
        mockedFs.existsSync.mockImplementation((path) => {
            if (path.includes('overlay.config.json')) return true;
            // settings-pr1o: schema files + the project's data dir must
            // exist so module-load-time wiring (getSchemaVersion(),
            // createCommunitySyncService, etc.) sees real fixtures.
            if (typeof path === 'string'
                && (path.endsWith('.schema.json') || path.endsWith('/data') || path.endsWith('\\data'))) {
                return realFs.existsSync(path);
            }
            return false;
        });

        mockedFs.readFileSync.mockImplementation((path, ...rest) => {
            if (path.includes('overlay.config.json')) {
                throw new Error('Mock file read error');
            }
            // Schema files: passthrough to the real fs so getSchemaVersion()
            // sees the canonical properties.version.const clause.
            if (typeof path === 'string' && path.endsWith('.schema.json')) {
                return realFs.readFileSync(path, ...rest);
            }
            return '{}';
        });

        const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

        const { loadConfig, DEFAULT_CONFIG } = require('./index');

        const config = loadConfig();

        expect(config).toEqual(DEFAULT_CONFIG);
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[Config] Load failed, using defaults:'),
            'Mock file read error'
        );

        consoleSpy.mockRestore();
    });
});
