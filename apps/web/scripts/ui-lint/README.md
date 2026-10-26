# UI baseline ratchet

`npm run ui:lint` runs the rule regressions and checks application TypeScript/JSX
under `app`, `components` and `lib`. It does not load application modules, contact
services, or modify files. Tests, fixtures, generated declarations/data, and mocks
are excluded. Existing TypeScript supplies the parser; no dependency is added.

The rules reject new native confirm/prompt uses; dialog/alertdialog roles outside
`components/ui`; outline removal without a width ring in the same static class
string; arbitrary text sizes below 12px (including rem at the 16px base); literal
hex colors outside the explicit chart/overlay list in `rules.mjs`; and manually
styled link buttons described in the design-system roadmap. The hex exception
does not waive any focus, text, dialog or button rule. No filename-contains-chart
or blanket ignore-comment exception exists.

The two canonical before-paint browser `theme-color` tokens have a separate,
declaration-shaped exception: only `lib/theme.ts`'s top-level exported
`const THEME_COLORS`, containing exactly the `light` and `dark` literal six-digit
hex members, optionally wrapped with `as const`. Browser metadata must be set
before CSS loads. Other literals in that file, extra/computed members, shadow
bindings, other paths and unrelated rules remain checked.

AST rules ignore comments and documentation strings that mention calls. Lexical
bindings distinguish native `confirm()` from a local `useConfirm` result. Native
member references and destructuring are checked too. Link classes resolve local
constants in their lexical scope. Fragment/element IDs, URLs, CSS ID selectors
and SVG filter references are not interpreted as color declarations. This is a source regression guard, not a full
CSS interpreter: runtime-generated classes, imported class constants, and dynamic
property names still need normal review and accessibility/browser checks.

Each allowance contains its exact file, rule and SHA-256 of token-normalized
syntax, plus an occurrence count and readable example. Whitespace, comments,
line numbers and literal quote changes do not grant a new allowance. Adding an
identical second violation exceeds its count; another file or changed element
cannot borrow that allowance. Existing debt remains visible in the checked-in
baseline, rather than being represented by path-wide ignores.

After removing violations, run `node scripts/uiLint.mjs --prune-baseline` and
review the baseline diff. Pruning fails if any new/increased signature exists;
it can only remove or reduce allowances. CI rejects stale allowances as well
as new ones, so removed debt cannot silently return later. There is an explicit
`--write-baseline` bootstrap/review command, which may add debt and must never be
used as an automatic repair or in CI. Normal CI does not rewrite the baseline.

The initial baseline records existing debt; it does not claim all older dialogs,
colors or text have been migrated. Consumer migrations remain separate work.
