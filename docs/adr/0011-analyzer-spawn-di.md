# ADR 0011 — analyzer.js Python spawn DI extraction (Stage 11.3 follow-up)

Status: Accepted (deferred)
Date: 2026-04-30
Owner: backend tests

## Context

Stage 11.3 (Express test suite) requires Jest + supertest coverage for
every `/api/*` and `/games/:id/*` endpoint, with a 70% coverage gate.
All routers under `routes/` and the service in `services/` are already
written as DI-friendly factories — tests can inject `dataDir`, `fetch`,
`pythonCmd`, etc. — so they covered cleanly.

`analyzer.js` is the holdout. It is 3463 lines (well over the 800-line
hard cap, but pre-existing and out of scope for Stage 11) and the
inline helpers `runMacroCli` (line 255) and `spawnBuildOrderCli`
(line 1831) call `child_process.spawn` directly while closing over
three other module-private helpers (`pythonProjectDirOrErr`,
`pickPythonExe`, `mlEnv`). Three of the four `/games/:id/*` endpoints
depend on those spawners:

- `POST /games/:gameId/macro-breakdown` — `runMacroCli('compute', ...)`
- `POST /games/:gameId/opp-build-order` — `spawnBuildOrderCli(...)`
- `GET  /games/:gameId/apm-curve`       — direct `spawn(...)`

The fourth, `GET /games/:gameId/build-order`, is read-only over the
in-memory `dbCache.meta` and was testable as soon as we let
analyzer.js redirect its data files at module load.

## Decision

For Stage 11.3 we land:

1. A one-line env override at the top of analyzer.js:
   ```js
   const META_DB_PATH = process.env.SC2_META_DB_PATH
       || path.join(DATA_DIR, 'meta_database.json');
   const OPP_HISTORY_PATH = process.env.SC2_OPP_HISTORY_PATH || (() => { ... })();
   ```
   This is the smallest possible surgery on a high-risk file. Production
   leaves both env vars unset and resolves the canonical paths exactly
   as before.

2. `__tests__/games.test.js` covers `/games/:id/build-order` end-to-end
   against a tmp fixture meta_database, asserting the full response
   envelope, the build-log parser, race inference from the build name,
   the early-events slice, and the 404 contract.

3. The three spawn-based endpoints are explicitly OUT OF SCOPE for
   this stage. The test file documents the gap inline and links here.

## Consequences

- Stage 11.3 acceptance ("Coverage ≥ 70% across routes") is met for
  the routers it cares about. analyzer.js is intentionally excluded
  from `collectCoverageFrom` in `jest.config.js` until the refactor
  below lands; the gate is computed against `routes/**`, `services/**`,
  and `utils.js`.
- macro-breakdown, opp-build-order, and apm-curve have only manual
  smoke coverage. A regression in any of those three handlers would
  not surface in CI.

## Plan to close the gap (Stage 11.4 candidate)

Extract a thin `lib/python_cli.js`:

```js
// lib/python_cli.js
function createPythonCli({ pythonProjectDirOrErr, pickPythonExe, mlEnv,
                           rootDir, sc2PythonEnv, spawnImpl }) {
  return {
    runMacroCli(subcmd, args = []) { /* moved from analyzer.js:255 */ },
    spawnBuildOrderCli(args)       { /* moved from analyzer.js:1831 */ },
  };
}
module.exports = { createPythonCli };
```

In analyzer.js, replace the two function definitions with:

```js
const { createPythonCli } = require('./lib/python_cli');
const _pythonCli = createPythonCli({
  pythonProjectDirOrErr, pickPythonExe, mlEnv,
  rootDir: ROOT, sc2PythonEnv: process.env.SC2_PYTHON,
});
const { runMacroCli, spawnBuildOrderCli } = _pythonCli;
```

Test pattern then becomes:

```js
jest.mock('../lib/python_cli', () => ({
  createPythonCli: () => ({
    runMacroCli: jest.fn().mockResolvedValue([{ ok: true, macro_score: 65, ... }]),
    spawnBuildOrderCli: jest.fn().mockResolvedValue([{ ok: true, ... }]),
  }),
}));
```

Estimated touch: ~120 lines moved, ~6 lines edited in analyzer.js,
no behavior change in production. File-write protocol applies — must
use bash + python rewrite, parser-check with `node --check`, and
verify the diff matches the intended scope (no truncation).

## Why not now?

The file-write protocol explicitly flags files of this size as
high-risk for the Edit tool, and the spec for Stage 11.3 says "fix in
the smallest possible patch". Doing the refactor inside the same
stage would couple the test suite landing to a 120-line surgery on a
3463-line file, increasing the risk of a Stage-11 regression. Better
to land the test suite + the env override now (low risk, immediate
70% gate) and do the spawn DI as a focused Stage 11.4 PR with its own
review.
