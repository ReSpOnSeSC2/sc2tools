# Contributing — type-check pass

This package uses TypeScript's `--checkJs` mode against plain JavaScript
files. We do NOT compile TS files; we use `tsc --noEmit` to type-check
JS files that opt in via `// @ts-check` at line 1.

## Why this approach

- Zero migration overhead for the existing 14k+ lines of JS.
- Per-file opt-in (Boy Scout Rule) — touch a file, add `// @ts-check`,
  fix the errors that surface, commit. No big-rewrite PRs.
- Runtime behaviour unchanged — `tsc --noEmit` only inspects.
- The JSDoc you write for human readers becomes machine-checked.

## How to opt a file in

1. **Add complete JSDoc** to every public function/class in the file.
   Hit the engineering preamble standard: param types, return type,
   `Example:` block. The lib/ modules already do this — copy that style.
2. **Add `// @ts-check` as the very first line of the file.** Even before
   `'use strict'`.
3. **Run `npm run typecheck`.** Fix every error TS surfaces in your file.
   Don't suppress with `// @ts-ignore` unless you have a written
   reason in a code comment.
4. **Run `npm test`** to confirm nothing regressed at runtime.
5. **Commit.**

## Common TS errors when opting in

| Error | Cause | Fix |
|-------|-------|-----|
| `'err' is of type 'unknown'` | Caught error in strict mode | `const message = err instanceof Error ? err.message : String(err);` |
| `... has no construct signatures` (ajv etc.) | CJS default-export interop | `const Lib = /** @type {any} */ (require('lib'));` |
| `Type '{}' is not assignable to '{[k:string]:T}'` | Empty-object inference | Annotate the variable: `/** @type {{[k: string]: number}} */ const out = {};` |
| `Property 'X' does not exist on type 'never'` | Variable initialized to `null` | Annotate with the eventual type: `/** @type {Foo \| null} */ let x = null;` |
| `Argument of type 'string \| undefined' not assignable` | Optional that needs to exist by this point | Narrow with an `if (!x) throw new Error(...)` early return |

## Migration order (what to opt in next)

1. **`lib/atomic-fs.js`** ✓ done
2. **`lib/datastore.js`** ✓ done
3. **`lib/schema-version.js`** ✓ done
4. **`__tests__/_helpers/index.js`** — small file, well-documented,
   would catch any test-helper API drift.
5. **`routes/settings.js`** — high-traffic, touches profile + config.
6. **`routes/backups.js`** — already well-structured.
7. **`routes/diagnostics.js`** — many checks; types catch regressions.
8. **`services/community_sync.js`** — has the most error-handling code;
   biggest win from caught-error narrowing.
9. **`routes/custom-builds.js`** + **`routes/custom_builds_helpers.js`**
   — paired migration; share the schema types.
10. **`routes/onboarding.js`** — heaviest network surface.
11. **`utils.js`** — small.
12. **`index.js`** — last because it's 2100 lines; will need split before
    typecheck pass is realistic.
13. **`analyzer.js`** — needs ADR 0011 (spawn DI extraction) first; too
    big to opt in monolithically.

## Tightening the screws (later)

When most of `routes/` and `services/` are opted in:

- Set `"noImplicitAny": true` in `tsconfig.json` to catch any missed
  annotation.
- Set `"checkJs": true` (currently `false` so opt-in is per-file). With
  `checkJs: true`, `// @ts-check` becomes implicit for every JS file
  in the include list — useful when 90%+ of files are migrated.
- Wire `npm run typecheck` into CI alongside `npm test` (the
  `backend-jest.yml` workflow added in Stage 11.3).

## Scripts

```bash
npm run typecheck         # tsc --noEmit (lenient: only // @ts-check files)
npm run typecheck:strict  # tsc --noEmit --strict (every JS file, future-mode)
npm test                  # jest
```

## Why `noImplicitAny: false`

To make opt-in incremental. With it enabled, every JS file in the
include list (regardless of `// @ts-check`) starts erroring on
implicit `any` and we'd drown in noise from the long tail. Files that
DO opt in still get strict null checks + caught-error narrowing
because those flags are independent.

Flip to `true` when the long tail is migrated.
