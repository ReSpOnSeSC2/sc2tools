"use strict";

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  collectCoverage: true,
  collectCoverageFrom: ["index.js", "src/**/*.js"],
  coverageReporters: ["text", "lcov", "json-summary"],
  coverageThreshold: {
    global: { branches: 70, functions: 70, lines: 70, statements: 70 },
  },
  testTimeout: 30000,
  clearMocks: true,
  restoreMocks: true,
};
