## Engineering Standards & Refactoring Practices

> Paste this section AFTER the Master Architecture Preamble in every prompt. It is the single source of truth for code-quality rules. Definition-of-Done checks reference back here.

These are not opinions — they are non-negotiable production rules. Every prompt must satisfy them. If a Stage's prompt seems to conflict with these standards, the standards win and the prompt is wrong (open an issue and amend).

### Hard size limits

| Unit | Target | Hard cap | Why |
|---|---|---|---|
| File (Python / JS / TS) | 200–400 lines | 800 lines | Past 800, comprehension dies. Split. |
| Function | ≤ 30 lines | 60 lines | Past 60, extract helpers. |
| Class | single responsibility | 200 lines or 7 public methods | Past either, split into smaller classes. |
| Cyclomatic complexity | ≤ 8 per function | 10 per function | Use `radon` (Python) and `eslint-plugin-complexity` (JS). |
| Nesting depth | ≤ 3 levels | 4 levels | Past 4, extract a helper or use early returns. |
| Function arguments | ≤ 4 | 6 | Past 6, take a dataclass/object instead. |
| Line length | 100 chars | 120 chars | Set in `ruff` and `prettier`. |

> The single biggest exception: the analyzer SPA `public/analyzer/index.html` is intentionally a single-file React app with no build step. It will exceed the file limit. Treat its inline component definitions like separate files — each component still respects the function/class/complexity caps. When a logical unit grows beyond ~400 lines inside that file, extract it into a sibling component file under `public/analyzer/components/` and import it.

### Single Responsibility

- One module = one concern. If you can't summarize a file's purpose in one sentence without "and", it does too much.
- Pure functions where possible. Side effects (file I/O, network, time, randomness) live at the edges (handlers, `main`, watchers, CLI scripts).
- No circular imports. If you need one, you have a layering bug — extract a third module.

### Naming

- Python: `snake_case` for vars/functions, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants, `snake_case` for files.
- JS/TS: `camelCase` for vars/functions, `PascalCase` for classes/components, `UPPER_SNAKE_CASE` for constants, `kebab-case` for files (except React components which match component name).
- No single-letter names except loop indices (`i`, `j`) and well-known math (`x`, `y`, `t`).
- Boolean names start with `is_`, `has_`, `can_`, `should_`.
- No abbreviations except universal ones (`url`, `id`, `db`, `api`, `pid`).

### No magic values

- Every literal number that isn't 0, 1, or -1 gets a named constant.
- Every literal string that's used in more than one place gets a named constant.
- Constants live at the top of the file or in a `constants.py` / `constants.ts` per package.

### Type safety

- Python: type hints on every public function. `mypy --strict` in CI. `from __future__ import annotations` at top of every module.
- TypeScript: `strict: true` in tsconfig. **No `any`**. No `as Foo` casts unless justified by a comment. Prefer `unknown` + narrowing.
- Plain JS that won't migrate to TS: full JSDoc with `@param`/`@returns` types, validated by `tsc --checkJs`.

### Error handling

- Never swallow exceptions silently. Either re-raise, log with context, or convert to a domain error.
- Catch the **narrowest** exception type that applies. `except Exception` is a code smell.
- Logs use structured fields, not string concatenation: `logger.warning("ingest rejected", extra={"client_id_hash": h, "reason": r})`.
- Wrap third-party errors in your own domain errors at module boundaries.

### Testing

- Unit tests for every public function. Integration tests for every HTTP endpoint and MCP tool.
- **Real fixtures over mocks** wherever possible (see Stage 11.1). Mocks are a last resort and must be labeled.
- Test naming: `test_<function>_<scenario>_<expected>`. e.g. `test_compute_macro_score_with_zero_workers_returns_zero`.
- Property-based tests (Hypothesis / fast-check) for any function with a non-trivial input space.
- TDD for bug fixes: write the failing test FIRST, watch it fail, then fix.
- Coverage gates in CI: ≥ 80% Python, ≥ 70% JS/TS. PR is rejected if coverage drops.

### Documentation

- Every public function/class: docstring (Google style for Python, JSDoc for JS/TS) with `Example:` block.
- Every module: top-of-file comment stating purpose.
- Every package: `README.md` with install / usage / "where to start reading".
- Every non-trivial decision: an ADR (Architecture Decision Record) under `docs/adr/NNNN-title.md`.
- **No commented-out code.** Delete it; git remembers. The only exception is a TODO with a ticket reference and a date.

### Linting & formatting

- Python: `ruff check` + `ruff format`. Pre-commit hook installed via `pre-commit install`.
- JS/TS: `eslint` (with `@typescript-eslint`) + `prettier`. Pre-commit hook.
- HTML/CSS: `stylelint` for the overlay widgets.
- A top-level `CONTRIBUTING.md` documents every rule and how to run them locally.
- CI rejects any PR with lint errors. No exceptions; if a rule is wrong, change the rule with its own PR.

### Git / PR hygiene

- One concern per PR. If you find yourself writing "and also" in the description, split.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `perf:`, `style:`.
- PR template requires: what / why / how tested / screenshots (UI changes) / migration notes (data changes).
- CI gates: lint + type + tests + build all green before merge.
- No `--force-push` on `main` or any shared branch. `--force-with-lease` only on your own feature branch.
- Squash-merge by default; preserve a clean linear history on `main`.

### Security

- All HTTP input validated server-side: `ajv` (JS) or `pydantic` (Python). Never trust the client.
- All SQL via parameterized queries or an ORM. **No string interpolation into queries, ever.**
- Secrets via env vars (or a secrets manager in cloud). Never in source. Never in logs.
- Atomic file writes for any data/* mutation: write to `.tmp`, fsync, rename. (Pattern: `persistMetaDb` in `analyzer.js`.)
- Never log PII (opponent names, battle tags, push tokens, refresh tokens, IPs). Hash or redact at the logging layer.
- Subprocess calls: pass arg lists, never `shell=True` with user input.
- Rate-limit every public endpoint. Default: 60/min per client.
- HMAC-sign every cross-service request (Stage 7.3, Stage 14).

### Performance

- Cache hot reads. Default TTL 5 minutes; document any deviation.
- Use streaming/async for any operation that could exceed 500ms.
- Watch for N+1 queries — use batched queries, prefetch, or join.
- Profile before optimizing. `cProfile` (Python), Chrome devtools (JS).
- Hard pagination limits: max 100 rows per response.
- Set timeouts on every outbound HTTP call. Default: 5s connect, 30s read.

### Observability

- Structured JSON logging (`python-json-logger` / `pino`).
- Log levels: DEBUG = dev only; INFO = expected production flow; WARN = unusual but recoverable; ERROR = caller-visible failure; CRITICAL = process-level fault.
- Every endpoint emits at minimum: a counter (`requests_total`) and a histogram (`request_duration_ms`), tagged by route and status.
- OpenTelemetry tracing in Stage 14+ services. Spans for: every endpoint, every DB query, every outbound call.
- Sentry for exception aggregation. Don't replace structured logs with Sentry; complement.

### Refactoring practices

- **Boy Scout Rule**: leave the code cleaner than you found it. Renaming a variable for clarity in a feature PR is encouraged.
- Incremental refactors only. **Never a "big rewrite" PR.** If a refactor is more than ~400 lines, split it into a series of behaviour-preserving steps, each with its own tests.
- Add tests BEFORE refactoring. The point of refactoring is "behaviour unchanged"; you can only verify that with tests.
- Use a deprecation cycle for public-API changes:
  1. Add the new API alongside the old.
  2. Mark the old with a deprecation warning + a `Deprecated:` line in the docstring + a removal date.
  3. Migrate callers (separate PR per caller cluster).
  4. Remove the old API in a release one minor version later.
- Document architectural changes in `docs/adr/`.

### Dependency hygiene

- Pin every dependency. `requirements.txt` uses `==`, not `>=` or `~`. `package.json` uses exact versions in production manifests; ranges only in dev deps.
- Lockfile committed (`package-lock.json`, `uv.lock`, `requirements.lock`).
- Weekly `npm audit` / `pip audit` / `uv audit` run in CI; high-severity findings block merge.
- Major version bumps live in their own PR with a CHANGELOG entry.
- Prefer one well-supported library over five micro-deps. The dep tree IS the security surface.

### Accessibility (any UI work)

- WCAG AA contrast: 4.5:1 body text, 3:1 large text. Verify with `axe-core` in CI.
- Every interactive element reachable via Tab in visual order.
- `aria-label` on every icon-only button.
- Visible `focus-visible` ring on every interactive (use design tokens).
- Respect `prefers-reduced-motion`: animations replaced with instant transitions.
- Live regions (`aria-live="polite"`) for async UI updates (toasts, predictions, errors).
- All form fields have `<label htmlFor>` (or wrapped) — never placeholder-only.

### File-system layout rules

- One package = one folder under the relevant subtree.
- Tests live in `tests/` (Python) or `__tests__/` (JS) — siblings to the code they test, not a separate top-level tree.
- Generated files (build outputs, model pickles, caches) live under `data/` or `dist/` and are `.gitignore`'d.
- Skill files, hooks, plugin manifests follow the conventions of their respective tooling — do not invent custom layouts.

### Production-readiness Definition of Done (every Stage)

Before declaring any Stage shipped, every PR within that Stage must pass:

- [ ] All Stage-specific Definition-of-Done items met.
- [ ] No file > 800 lines (run `find . -name "*.py" -o -name "*.js" -o -name "*.ts" | xargs wc -l | awk '$1 > 800'`).
- [ ] No function > 60 lines.
- [ ] No cyclomatic complexity > 10.
- [ ] `ruff check`, `mypy --strict`, `eslint`, `tsc --noEmit` all clean.
- [ ] Coverage gates pass (≥ 80% Python, ≥ 70% JS).
- [ ] Manual smoke test on real data documented in PR description.
- [ ] `grep -i 'TODO\|FIXME\|XXX\|HACK' <changed files>` shows zero new entries (or each has a ticket reference).
- [ ] Logs grep clean of PII (run a 100-request load and grep for opponent names, tokens).
- [ ] Screenshots captured for any UI change (committed to `docs/screenshots/`).
- [ ] `CHANGELOG.md` updated with a user-facing entry.
- [ ] Migration scripts (if any) tested forward AND backward on a copy of production data.
- [ ] Rollback plan documented in PR description.

### Standalone audit prompt — run after each Stage

Use this between Stages to enforce the standards across the changes that just landed.

```
Read [Master Architecture Preamble] and [Engineering Standards & Refactoring
Practices].

GOAL: Audit the diff between <BASE_REF> and HEAD against the Engineering
Standards. Produce a remediation plan + apply mechanical fixes. Do NOT
introduce new features.

PROCEDURE:

1. Inventory the changed files:
     git diff --name-only <BASE_REF>..HEAD
   For each file, record: path, language, line count, function count.

2. Hard-size audit:
   - Any file > 800 lines: propose a split. Identify natural seams
     (cohesive groups of functions/classes). Output the proposed
     new files with the moved symbols listed for each. Apply if
     uncontroversial; otherwise emit a TODO with rationale.
   - Any function > 60 lines: extract helpers. Apply.
   - Any class > 200 lines or > 7 public methods: propose a split.

3. Complexity audit:
   - Run `radon cc -s -a <changed *.py>` and capture B+ rated functions.
   - Run an ESLint pass with complexity rule set to 10 on changed JS/TS.
   - For every offender, refactor (extract helper, early return, lookup
     table). Apply.

4. Type audit:
   - `mypy --strict` on changed Python. Fix every error. No new `# type: ignore`
     without a comment justifying it.
   - `tsc --noEmit --strict` on changed TS. Fix every error. No new `any`.

5. Lint audit:
   - `ruff check --fix` on changed Python. Run `ruff format`.
   - `eslint --fix` + `prettier --write` on changed JS/TS.

6. Magic-value audit:
   - For each numeric literal in changed code that's not 0/1/-1: confirm
     it lives in a named constant. If not, extract.
   - Same for any string literal used in more than one place.

7. Naming audit:
   - Single-letter names outside loop indices: rename.
   - Abbreviations not in the allowlist: rename.
   - Booleans without is_/has_/can_/should_ prefix: rename.

8. Doc audit:
   - Every new public function/class has a docstring with an Example.
   - Every new module has a top-of-file purpose comment.
   - Every new package has a README.

9. Test audit:
   - Every new public function has at least one test.
   - Every new endpoint has happy-path + 400 + 404 + 500 tests.
   - No new test uses a mock where a real fixture would work.

10. Security audit:
    - Every new HTTP input is validated by ajv/pydantic.
    - No new string-interpolated SQL.
    - No new secrets in source. (`gitleaks detect` on the diff.)
    - No new PII in log lines (`grep -E 'opponent_name|battle_tag|push_token'`
      on changed files).

11. Dependency audit:
    - Every new dep is pinned exactly.
    - Lockfile updated.
    - Run `npm audit` / `pip audit`; no new high/critical findings.

12. PR-readiness:
    - Conventional commit subject.
    - PR description has: what / why / how tested / screenshots /
      migration notes / rollback plan.
    - CHANGELOG.md updated.
    - All Definition-of-Done checkboxes from the Stage met.

OUTPUT:
- A markdown report at `docs/audit-reports/<date>-<stage>.md`:
    ## Summary
    ## Files audited
    ## Auto-fixed (with diff stats)
    ## Manual remediation needed (with proposed PRs)
    ## Standards violations not yet fixed (with rationale)
- The mechanical fixes themselves, applied as a single commit:
    refactor(audit): apply <stage> engineering standards
- A list of follow-up tickets for anything that needs human judgment.

VERIFY:
1. After applying fixes: `make test lint type` (or equivalent) all pass.
2. Coverage didn't drop.
3. No behaviour changed (run smoke tests on real data; document results).
4. The audit report is committed to docs/audit-reports/.

NO MOCKS. The audit runs against real changed files, real lint output,
real test runs.
```

### Continuous-enforcement scaffolding (set up once, in Stage 0)

Add this as a sub-task to Stage 0 (before Stage 0.1 — fix `build_definitions.py`):

```
Read [Master Architecture Preamble] and [Engineering Standards & Refactoring
Practices].

GOAL: Set up the tooling that makes the standards self-enforcing. One-time
setup; every later Stage just relies on the gates being there.

CREATE:
- .pre-commit-config.yaml at the repo root with hooks for:
    ruff (check + format), mypy, eslint, prettier, stylelint, gitleaks,
    end-of-file-fixer, trailing-whitespace, check-merge-conflict,
    check-yaml, check-json, no-commit-to-branch (main).
- .github/workflows/ci.yml that runs:
    - Python: ruff, mypy --strict, pytest with --cov, radon cc threshold.
    - JS/TS: eslint, tsc --noEmit, jest with --coverage.
    - File size scan: fail if any tracked file > 800 lines.
    - axe-core a11y scan on the SPA + overlay HTML.
    - npm audit + pip audit, fail on high/critical.
- .github/PULL_REQUEST_TEMPLATE.md with the required sections.
- CHANGELOG.md (Keep a Changelog format, v1.0.0).
- CONTRIBUTING.md documenting every standard + how to run each tool locally.
- docs/adr/0001-engineering-standards.md recording the decision to adopt
  these standards.
- docs/adr/template.md for future ADRs.
- Editor configs:
    .editorconfig (cross-IDE)
    .vscode/settings.json (workspace defaults — format on save, ruler at 100)

Configure tools:
- pyproject.toml: [tool.ruff] line-length=100, target=py312;
  [tool.mypy] strict=true; [tool.pytest.ini_options] addopts="-ra -q
  --cov --cov-fail-under=80".
- package.json: prettier + eslint scripts, "engines.node": ">=22".
- tsconfig.json (where TS lands): strict, noUncheckedIndexedAccess,
  exactOptionalPropertyTypes.

Run once locally to confirm everything works:
  pre-commit run --all-files
  python -m pytest
  cd reveal-sc2-opponent-main/stream-overlay-backend && npx jest

Definition of Done:
- All hooks pass on a clean checkout.
- CI runs on a draft PR and stays green.
- A deliberate violation (commit a file > 800 lines on a test branch)
  is rejected by CI.
- CONTRIBUTING.md links to every config and explains how to run each
  tool in under 30 seconds.
```

> **Insertion note:** add the bullet "Stage 0.0 — Engineering enforcement scaffolding" at the top of Stage 0 (before 0.1), and make it a prerequisite for every later Stage.

## Realtime connections and chart refreshes

`AppShell` mounts `RealtimeProvider` beneath Clerk for both signed-in shells. It never wraps `/overlay` or `/dock`, whose token sockets keep their separate authentication and lifecycle. Current user and admin consumers subscribe to a single ref-counted socket per provider; a standalone `useUserSocket` retains its local fallback. The last subscriber closes the connection, with a one-tick grace period for React StrictMode's effect probe. socket.io-client 4.8.1 creates a new Manager when the `/` namespace is already cached, so separate `io(API_BASE)` calls did not share a connection.

The auth callback requests a current Clerk token for every namespace handshake. Only namespace `connect` marks the connection live. Manager reconnect can precede namespace authorization and does not prove that events are flowing. Namespace failures use capped retries; account changes dispose the old connection and reject delayed events and auth callbacks. Connection state exposes `status`, `attempts`, and `lastConnectedAt`. Admin consumers receive `admin:event` on the same socket because the server joins authenticated admins to the admin room. Their connect callbacks revalidate durable REST rows, and existing slow REST polling remains available when events are missed. The Dashboard and Notifications show text status and a manual Refresh control while disconnected.

`games:changed` carries `{ count, inserted, bulk, reason }`. Ingest obtains `inserted` from actual upsert outcomes; `bulk` is the inverse of the existing `pickFreshOverlayGame` gate. Reclassifications and build-intent edits use `inserted: 0` with an explicit reason. The header increments by `inserted`, never by accepted or rewritten rows, and updates its relative timestamp every 30 seconds with an absolute-time tooltip.

The shared chart clock trails ordinary game events by two seconds with a ten-second maximum wait. An explicit bulk event or more than three events in ten seconds switches to a 30-second refresh cadence. All chart consumers receive the same aggregated invalidation; the active Arcade corpus skips its older extra 30-second quiet delay when fed by AnalyzerProvider (standalone corpus users retain that fallback). the header receives raw inserted counts immediately and shows the bulk refresh notice. Import progress, booking alerts, notifications, and admin events remain immediate. The all-consumer integration test mounts SyncStatus, NotificationBell, CoachingBookingAlert, BuildCheckInProvider, AnalyzerProvider, AnalyzerFrame, useImportStatus, AdminShell, Dashboard, Notifications, and CoachingPractice together and asserts one socket plus event and reconnect fan-out.

## Per-user revision cache (opt-in source)

`USER_CACHE_ENABLED` enables the first chart-cache slice only when its value is
the literal string `true`. The default and `.env.example` are false. While off,
the six routes call their original services and `res.json` directly; revision
hooks add no database command, owner lookup, retained body, admission limit or
new busy response. The flag is not changed by source preparation.

Before enabling, an operator must verify one API instance, a fully settled
deployment and upgraded writers throughout that instance. The Render blueprint
already pins one instance for process-local realtime state. This implementation
does not establish distributed coherence during a rolling overlap or an
out-of-band database write. Do not enable during either condition; no migration,
index, warmer or new infrastructure is part of this slice.

The allowlist is `/v1/timeseries`, `/v1/timeseries/day-hour`,
`/v1/length-buckets`, `/v1/activity-calendar`, `/v1/momentum` and
`/v1/timeseries/maps`. Existing parsing, filters, calculations and history bounds
stay in their original aggregation methods. All global filters are dependencies:
even a time chart's membership can change after an opponent MMR or region stamp.
Doctor/health, opponents and notes, build stats, Explorer, global calibration,
exports, streams and tokens are outside this allowlist.

Every selected-input writer calls `gameWrite` inside its service or existing
job around the semantic Mongo attempt. `UserRevision` retires owner tokens
before and after the attempt and invalidates both response bytes and existing
TrendsRequests joins. This applies without Socket.io and after unknown write
outcomes, swallowed metadata errors, partial restores and later detail failures.
Reclassification retires at promotion, not at every staging page. Custom-build
rename fencing spans transaction commit. Active work retains its admission
permit after invalidation. Internal bookkeeping, storage leases and the legacy
isLadderMap backfill do not change these six chart inputs.

An existing user's absent `dataRev` seeds as zero; a guarded `$inc` creates it on
the first semantic change. There is no revision upsert or automatic legacy-data
repair. Invalid/unsafe revisions and ambiguous persistence failures bypass cache
reuse. The original mutation result/error wins over revision or logging failure.
Persistence accepts only missing or safe integral BSON int/long/double fields;
Decimal128, unsafe Longs, nonfinite and other invalid legacy values stay unchanged.
Revision persistence has four active permits and no waiter queue; saturation
retires local generations and bypasses retention instead of adding database work.
In-memory owner identities and a random process epoch fence late completion and
eviction ABA. Durable revisions are advisory monotonic versions, not a game
count, transactional snapshot or corpus change watermark. Snapshot restore never
copies an archived dataRev over current lifecycle state.

Every retained hit follows existing authentication plus a fresh unique-user and
identity-deletion guard, including device requests. GDPR locks cannot use cache.
A delayed computation rechecks owner deletion before sending. Typed canonical
keys retain the authenticated owner, route, every parsed filter/option, revision
and generation; JSON objects are serialized once and never shared as mutable DTOs.
Generation identity is captured before the guard and checked after work and at
subscriber publication. A retired generation returns 503 with Retry-After: 1,
without an old DTO or automatic retry; the next explicit request reads fresh.
Cache eligibility is separate: stable-generation dirty/active/invalid-revision
reads may still perform bounded fresh work without retaining its body.
Owner/identity guards have an independent 16-operation limit and no queue. Their
permit lasts until findOne and isDeleted actually settle, including post-compute
guards and aborted/closed HTTP responses. Saturation returns 503; fixed
guard_active/guard_rejected gauges share the existing private metrics registry.

Retention is limited to 64 MiB of UTF-8 body/key/validator bytes, a 512 KiB body, 512 entries,
16 KiB keys and an absolute ten-minute TTL. Response-pinned retired buffers remain
charged; reservations precede computation. This budget does not claim to bound
all Node/Mongo working memory. Oversized responses retain their original schema
and are sent uncached while holding admission through response completion.
There are at most four active computations (two per owner), 32 waiting
subscribers, 16 subscribers per key and 64 response leases. Queue deadline is five
seconds; a slow response closes after 30 seconds. Cancellation releases its own
waiter, never another subscriber's running permit. Capacity failures use 503 and
Retry-After: 1 instead of launching unbounded fallback work.

Enabled stable retained responses include a process-salted weak ETag derived from
the full typed key and exact serialized JSON. They use `private, no-cache` and
`Vary: Authorization`; every subscriber independently receives 200 or an empty 304
after the existing fresh identity/revision guards. A bounded If-None-Match parser
accepts HTTP weak comparison and rejects malformed/oversized lists by sending 200.
Validator bytes occupy the existing cache entry and reservation, not another
cache. Dirty, active, invalid-revision and oversized bypass bodies stay 200 with
`private, no-store`. OFF preserves the original Express JSON/freshness behavior.
CORS exposes ETag without changing allowed origins or authentication.

Only the six allowlisted useApi paths can discover the explicit enabled-cache
capability and start a background dynamic import. Before that module is ready,
after import failure, or outside the AppChrome conditional provider, useApi makes
one ordinary request. No eager retained-body engine or import wait is added to
other consumers. A cold ordinary capability response is not retained; the next
eligible 200 may be retained, and later revalidations can send its tag.

One lazy engine per browser document retains immutable JSON text, with a fresh
JSON.parse for each 304. The central provider supplies account/provider epochs;
A→B→A and real unmount retire old ledger authority, while StrictMode effect replay
keeps it. This does not change initiating-hook cancellation, Retry, SWR keys or
resource lifetimes. The exact captured origin/owner/provider/full path, including
query and #rev, is the ledger identity. A held old-key operation may still complete
only into that old key under the existing initiating-hook SWR baseline; changing
one hook's path does not retire a sibling's old key.

The logical retained-representation budget is 8 MiB across current and retired
pins: raw UTF-8 body/key/tag bytes plus 256 bytes per entry. Limits are 64 entries
(including retired pins and candidate reservations), 512 KiB bodies, 16 KiB keys,
absolute ten-minute retention, and four active enhanced operations without a
queue. Reservations precede API admission. Pressure chooses one ordinary fetch,
not a new 503; oversized valid 200 JSON remains available without retention.
Actual fetch/body finally releases reservations and pins, even when an outer
timeout already rejected or an adapter ignored abort. This budget does not bound
VM heap, decoder/text/DTO transients, SWR's existing cache, or browser HTTP cache.

A 304 uses only its exact still-retained body/tag. If that body is absent,
expired or mismatched, one unconditional recovery uses the ordinary baseline;
a second raw 304 is an explicit missing-body error with a Retry message. HTTP
errors keep baseline availability and
reporting; admitted and ordinary reads share the same 401/403 retirement before
error-body decoding, including capacity/pressure fallback and unconditional 304
recovery. They clear capabilities, rotate a bounded retention token and retire
that account epoch's pairs while keeping the retirement listener for later
capability rediscovery. Older in-flight responses can return baseline data but
cannot refill the ledger or reuse retired 304 bodies after rediscovery. An
oversized successful 200 also retires its obsolete older pair. No mutation paths,
authentication cache, wider route allowlist, gameStats maintenance or production
flag activation are included. Route JavaScript budgets remain unchanged and must
be measured before delivery; source preparation alone proves no savings.
Identifier-free cache counters and byte/admission gauges use the existing private
METRICS_TOKEN registry only. Maintained gameStats, the 60-second device-auth lookup cache,
admin-health presentation, broader dependencies and IndexedDB/corpus deltas also
remain separate work. Source and test preparation is not measured speedup.

## Device liveness

Every device-auth request still performs one active-token lookup by the existing
unique tokenHash index, projecting only _id, userId and lastSeenAt. Authentication
never uses the metadata cache. Fresh REST reads add no activity write; at the
exact minute boundary a best-effort conditional write is eligible. Its atomic
predicate repeats owner, device, hash, active and stale conditions with no upsert.
A delayed REST touch cannot overwrite a newer heartbeat or touch a revoked row.
Four touch operations may run, one per hash; excess work is skipped without
delaying or failing authentication. Failed and unknown ACKs create no success
memo; a later authoritative read decides whether to retry.

latestAgent may retain a complete cloned DTO for an absolute 30 seconds. At most
1024 owner states, four cache-owned tasks and 16 coalesced subscribers per task
are retained. Capacity or active mutation is never a new metadata error: the
request performs exactly one ordinary projected query and returns its cloned
honest DTO without retention/coalescing. Baseline HTTP queries may therefore
exceed four; only cache-owned tasks use that admission limit. There is no added
query, retry chain, waiter, timeout or timer on the bypass path.

Retained UTF-8 owner-hash keys, touch-hash keys and DTOs share the same 512 KiB
budget. Each owner key is charged at creation, including empty, unpaired, pending
and active states. An evicted pending task keeps its key charged until IO and all
subscribers settle. DTO bytes are charged separately, at most 16 KiB per entry.
This does not claim to bound Mongo, all JS memory or baseline HTTP IO. Oversized
legacy versions are returned whole and skip retention before large serialization.

Issue, admitted REST touch, heartbeat, both revokes and actual account erasure
retire cached reuse and publication before/after possible writes, including lost
ACKs and exclusive-fence acquisition failure. A new caller cannot join a retired
cache generation. An already-issued metadata query may still return its original
DB snapshot to its existing callers, matching baseline concurrent-read semantics;
it cannot refill after retirement. This is CACHE coherence, not strict delayed
response rejection. It does not authorize any request: auth still reads an active
token every time. A mutation/overflow bypass likewise returns only its one real
query result, never a fabricated paired status or an unfenced cached DTO. Cache
fencing is independent of the optional chart-cache flag. State/byte saturation
retires or bypasses reuse while keeping all retained keys charged.

Heartbeat always processes metadata, connection-event retry and onHeartbeat even
after a recent REST touch. Literal pipeline fields preserve expression-like
strings and the date expression prevents older heartbeat liveness from moving
backward. Device labels do not affect this DTO; restore still excludes credentials.
No dependency, index, migration, auth lookup cache, provider call, configuration
flag or production activation is added. Source-bound validation history and raw
receipt pointers are recorded in [the device liveness checkpoint](handoff/device-liveness-checkpoint.md):
ae0 has types exit 0, raw strict lint exit 1 with twelve admitted inherited
warning owners, and 78 passes plus 27 fixture-setup failures; cd663 has clean
changed-file strict lint and 27 Mongo passes after correcting the unique Clerk
seed IDs. Both runs retain their pin/process-closure receipts. This is not a
single 105-case pass or measured speedup; whole-API integration remains for CI.

## Versioned guided tours

`lib/tours.ts` defines Today, Game and Overlay tours and their actual target
owners. A small admitted surface lazily loads its controller; targets must be
unique rendered nodes in that surface. Saved versions keep observers dormant
until explicit Help replay. Missing targets can be skipped, but an unsupported
layout reports unavailability rather than fabricating a target.

Owner, route, record and selected-credential lifetimes retire stale work before
and after held auth tokens or decoded response bodies, including ABA changes.
The actual sticky game navigator owns its target. Visible check-in variants,
external dialogs and fullscreen suppress admission; interruption does not save
or restart automatically. Reveal policy preserves already-visible targets and
rolls back an unsafe guarded scroll before paint. Phones use a bottom
sheet, keyboard/Escape stay in the active focus scope, and reduced motion is
respected without opening hidden panes.

Completion and Skip save one known tour/version through the existing onboarding
preferences. Mongo atomically merges siblings with a maximum version and returns
the committed projection; missing/GDPR-fenced owners cannot be acknowledged or
upserted. Other onboarding goals, dismissals and first-game markers remain
independent. Help replay does not reset saved progress or read the latest game
until an explicit Game replay action.

Local proof belongs to product `17c229bb`: the selected group first had 130 passes
and one provider-fixture failure, then the repaired target file passed eight cases
and strict lint, followed by 24 real-Mongo Foundation cases. There was no fresh
131/131 run. Inherited web/API lint debt retains raw nonzero exits and baseline
comparisons. Its own Next artifact generated 148 pages, passed all 81 unchanged
budgets and fresh post-build web types. The original browser matrix passed 12
cases once and retained 36 serious/critical AA scans with zero reported issues
and 22 incomplete color-contrast observations; this is not full certification.

The first metadata reader RED remains recorded. A PowerShell-only reinspection
corrected two missing expected CSS newline bytes and explicitly classified the
installed non-live tracer's intentional script-body omission. It verified 12 CSS
bodies and 12 script HTTP responses without claiming a captured raw-JavaScript
body/hash or rerunning browser tests. Root approved the 18 captures within the
synthetic target/owner-frame scope; eight raw PNGs are selected for delivery.
This is not full consumer-page, native fullscreen or production API proof.
See [the checkpoint](handoff/guided-tours-checkpoint.md) for exact heads, receipts,
validation limits and the pending fresh-main/integrated-CI boundary. Help source
and its canonical generated index are unchanged by the documentation delivery.


## Shared session policy

Profile stores an optional integer 15–480-minute gap; null means Auto and an
omitted legacy PUT preserves it. Auto uses 240 minutes for any persisted overlay
token record (including revoked/rotation-pending), otherwise 90. This preserves
existing four-hour live grouping through credential rotation. Stored replay-end
instants split only when the gap is strictly greater; equality, midnight and DST
stay connected. Eligible unknown results bridge before decided statistics, with
deterministic supported-scalar ordering and duplicate multiplicity retained.

Live/overlay aggregates, personal momentum and both session quizzes share the
policy while preserving their existing universes. Today keeps 14-day candidates,
future exclusion and an inclusive manual anchor. Global momentum keeps its own
partitions/gap. Mongo retains indexed bounds before a scalar BSON Date guard and
ordering/arithmetic, without a legacy rescue scan.

A tiny owner-scoped no-store read needs positive current-read admission. Profile
drafts stay local until an admitted PUT ACK; cache publication is advisory and
adds no confirmation GET. Bounded process-local gates/generations fence resolution
and final HTTP 200/304/private emits. No migration, new index, unbounded cache,
external service, public lease field or production flag activation is added.

Local targeted groups, current build/budgets/assets, synthetic Mongo explains and
the 24-case browser05 matrix passed. Root reviewed normal phone Profile and native
desktop 200% widget captures in both actual palettes. AA extraction retained
96 scans with 0 violations and 36 incomplete contrast observations; the SESSION
label's static contrast bound does not certify the whole product. Final web
selected02 passed after the label change and independent audit05 is clear.
Exact-head CI/delivery remain pending.
See [ADR 0067](adr/0067-session-policy.md) and the
[Sessions checkpoint](handoff/sessions-core-checkpoint.md).

### Reference build save correction (2026-10-27)

Reference source IDs use the same bounded opaque-string contract in web and
API validation. Composite IDs retain their exact player/map punctuation and
Unicode privately; public projections continue to omit the source ID. The
rich editor identifies invalid fields and offers an explicit Review action
that selects and visibly focuses its Build order tab. Diagnostic copy shares
the reader's scalar predicates but stays outside shared display modules.
The advisory name check still describes rules and never blocks Save. No data
migration, new service, provider setup or agent release is required.

## Private derived session history

History separates membership from output day/window and reuses the shared
replay-end kernel. Natural ignores the latest manual reset; current retains
its fixed live universe/inclusive anchor. Exact account, queued race and rating
scope separate recorded observations; only proved ranked 1v1 supports deltas
and connected curves. Missing values break the complete bounded curve while
point tables and game pages remain independent.

One bounded owner/date aggregate uses a scalar-Date guard, complete edge
certification, streaming/byte ceilings and owned cursor cleanup. Descriptors
are untrusted locators with whole-view consistency checks, not auth or database
snapshots. Private publication guards remain independent of optional cache
activation. Three route-local auth handlers preserve unrelated public routes.
Fresh private owner/path admission, chart-open intent and explicit one-time
Next-games focus preserve continuity without retaining old payloads. Saved
Views keep list/cohort and removable patch-era membership; a committed reset
sends an owner-room zero-insert invalidation through the existing clock.

Physical examined work is not bounded by returned-row/byte limits. Local scalar
explain is 2 keys/2 documents/2 rows with both bounds; Date-array multikey remains
1,008/1,008/3 with an upper-only winning bound. No new index/hint, migration,
provider activation, production saving/speedup or cache-flag change is claimed.

The retained 38-case browser matrix/60 AA scans had zero automated violations,
but manual review found 103 real low-contrast Terran labels. The table RaceTag
now uses existing theme tokens, keeping neutral unknown identity and global
chart colors. H11 adds four all-race palette cases with actual opaque-background
composition and raw ratios. Post-contrast unit/types/lint pass; own build03
passes all 83 original route caps. Browser06 passes all 42 cases with zero
skips/retries/flaky cases and retains 64 full AA reports, 214 incomplete nodes
and 96 computed normal/hover label observations. Independent recomputation agrees
exactly, minimum 4.7721:1; light/dark Terran are 5.2056:1/6.2910:1. Remaining
incompletes are 206 aria-hidden map initials and eight aria-hidden sort arrows,
with adjacent semantic text retained. Root reviewed normal/native layouts,
palettes and recovery/paging captures. This is bounded local evidence, not
product-wide AA certification. The executed source fingerprint,
later documentation-only equivalence and exact-head CI/production acceptance
remain distinct. See [ADR0068](adr/0068-private-session-history.md) and the
[contract/evidence checkpoint](handoff/sessions-history-checkpoint.md).

History also retains a private owner-reset revision independently of the
shared policy/privacy lease. GameDesk retires it before an anchor write and
in a synchronous finally directly after that write attempt. Held reads cannot
publish an older anchor after reset, including a write that commits then
reports failure. Fresh natural membership and locators remain unchanged.
The four actual application/Mongo reset regressions and the broader 243-test
API run pass; earlier-head CI does not accept this later API correction.
