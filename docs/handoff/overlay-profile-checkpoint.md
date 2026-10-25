# Live overlay profiles checkpoint

Task: `overlay-profile-sync` and its configurable-hold-times augment. PR: https://github.com/ReSpOnSeSC2/sc2tools/pull/717. Worktree: `.worktrees/wave3-coaching-forms`, branch `codex/wave4-overlay-profile-sync`. The previous saved-views branch and existing local cache are preserved.

## Result

- One authored JSON file supplies the 31 widget defaults, theme choices and display-time allowlist (5/10/15/20/30/45/60 seconds). API writes strictly validate bounded profiles on the existing token document.
- Private owner PUT uses `expectedRevision`; profile saves preserve widget enablement and credentials. Cache invalidation fences admitted reads, and a profile race requests a transient retry rather than declaring a valid token revoked.
- Existing sockets receive canonical profiles at connect and after Save. All-in-one, standalone and scene clients reject old revisions and retired token callbacks, including A→B→A transitions. Explicit URL theme presence wins, even when empty, malformed or repeated.
- Look and Widgets share one keyed draft, dirty guard and Save bar. The previous browser theme only enters a draft after opt-in. New source URLs follow the saved profile; older explicit `?theme=` URLs retain their look. Persistent/self-driven widgets do not store ineffective hold overrides.
- Display popovers use a viewport-positioned portal with outside dismissal and Escape focus return. Narrow theme fieldsets and Save actions remain contained at 320px; the popover uses the design system’s named sheet layer.
- Help `obs-overlay-setup`, each timed widget's Learn trigger text, troubleshooting, CHANGELOG, owner setup notes and ADR 0034 explain the behavior. No environment variable, migration, collection, index, paid service or production activation is added.

## Local verification

- 769 affected web tests across 60 files passed; 99 integrated profile/widget/Learn tests passed after fresh main included the merged replay and widget-manager foundations. The final token-transition refinement separately passed its 13 real-client regressions and strict lint.
- 62 API tests across 8 suites passed, including disposable Mongo ownership/CAS, stale in-flight cache, widget/profile field isolation, socket connect configuration, revocation, and flattened runtime packaging.
- Full web/API types passed. Changed web files passed strict lint; the new validator/tests passed strict API lint. Existing touched API files passed with their pre-existing function-length warning rule excluded.
- Required-engine build and smoke passed with bundle `604e9d4618a6414b`. The final web-only rebuild (`60777`) reused that verified unchanged engine and passed after the token-transition refinement.
- All unchanged performance budgets passed: landing 214.6/215, Today 228.4/240, opponent 476.0/500, all-in-one overlay 233.8/240, standalone widget 314.8/325, Settings 179.6/260 kB gzip.
- Final local Chromium harness passed 135 checks, with real SettingsShell, widget cards, profile draft and overlay clients. Explicit synthetic API/auth/socket/Next boundaries; all nonlocal traffic blocked. Widths 320/390/768/1440, light/dark; 20 captures under `docs/handoff/screenshots/overlay-profile-*`.
- Browser proof includes combined Save/reload retention, legacy opt-in without automatic write, owner reset, actual dirty-tab guard, persistent Display disabling, point-hit select controls, Escape focus return, URL precedence, old revision rejection, production hold extension and 5-second/20-second Test expiry on both clients.
- Help index regeneration left no content diff. Root independent source review found no blocking issue.

## Remaining release gates

Dependency PR 715 is merged. Fresh main, including replay PR 716, the widget manager, Rivals and playground PR 718, was integrated at `04835393`. Both profile and sample Docker copies, both Display and Preview controls, and all Help/setup changes are preserved. Types, 99 web consumers, 53 API/socket/dual-packaging cases, the production build/budgets and all 135 browser checks passed again. Final-head CI is the remaining gate. Read CI only through `read_pull_request_check_diagnostics`, retaining the returned head revision. Squash merge only after every GitHub check passes on the final expected head; inspect actual Vercel status. No production operation was performed during this work.
