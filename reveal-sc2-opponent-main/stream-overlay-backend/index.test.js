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
    const express = jest.fn(() => app);
    express.json = jest.fn();
    express.static = jest.fn();
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

describe('loadConfig', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        process.env.NODE_ENV = 'test';
    });

    it('should use DEFAULT_CONFIG when fs.readFileSync throws an error', () => {
        const mockedFs = require('fs');
        mockedFs.existsSync.mockImplementation((path) => {
            if (path.includes('overlay.config.json')) return true;
            return false;
        });

        mockedFs.readFileSync.mockImplementation((path) => {
            if (path.includes('overlay.config.json')) {
                throw new Error('Mock file read error');
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
