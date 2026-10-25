# Coaching practice — reviews-coaching-expansion-3

Active branch: `codex/wave4-coaching-practice`, from main `b3825e6d` in the
preserved merged Rivals worktree. Original Rivals branch and `.cache/` preserved.

Implemented the exact plan and how-to: Assign again through the rebuilt modal,
stored-field state filters/counts, an All-players roster, last qualifying game,
schedule badge, period strip/streak, full evidence W–L and inline Retry. Existing
private consent/grant scope, visible-state copy and replay evidence are retained.
The main workspace is split into bounded presentation modules. See ADR 0042.

Current verification: 66 API tests across five coaching suites, 89 web/coaching
tests and 77 Help checks (updated exact anchor fixture), API/web types and scoped
web lint green. Scoped API lint has zero errors and baseline legacy size warnings.
Fresh main `b2abc9c0` integrated cleanly. Required-engine production build passes
all unchanged budgets: landing 214.5/215 kB, Today 228.3/240, dossier 475.9/500;
coaching first load is 199 kB.

Forty browser assertions pass at 375/1440px, light/dark: actual workspace/clientApi,
production CSS and committed fonts, all nonlocal traffic blocked and four local
synthetic assignment posts. Eight captures are under
`docs/handoff/screenshots/coaching-{roster,plan}-{theme}-{width}.png`. Checks cover
roster ordering, selected-player/state scope, period history, W–L and retry,
unavailable-build prefill, modal geometry, saved payload and no overflow/errors.
Phone evidence wraps its text and puts the download control below it. Final
independent review and full remote gates remain pending.

No production account operation, migration, job, grade, score, AI, release,
infrastructure or budget change. Local synthetic tests only.
