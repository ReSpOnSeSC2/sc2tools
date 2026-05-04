"use strict";

// Coverage thresholds reflect what's reasonably testable in unit tests.
// Pre-cloud services (pairings, customBuilds, overlayTokens) and the
// socket.io auth wiring are exercised through the routes integration
// tests but the per-file coverage doesn't reflect that. The C-bucket
// services (aggregations, builds, perGame, spatial, catalog, import,
// ml, agentVersion) all have dedicated unit tests plus full HTTP
// coverage via __tests__/routes.integration.test.js.
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js"],
  coverageThreshold: {
    global: {
      lines: 50,
      branches: 40,
      functions: 50,
      statements: 50,
    },
  },
  clearMocks: true,
  testTimeout: 30000,
};
