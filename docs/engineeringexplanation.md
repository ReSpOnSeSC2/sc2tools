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