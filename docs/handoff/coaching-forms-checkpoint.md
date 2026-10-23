# Wave 3 coaching forms

Implements `reviews-coaching-polish-6` from `plan/final-plan.json`, including its folded `practice-form-validation` audit. Base: main `441582d0`.

## Behavior

- Extracted `AssignmentModal` is reusable by the later Assign again work. All assignment controls and the Practice player select use Field and Input/Select. The shared Modal and focus trap are unchanged.
- Pure `validateAssignmentDraft` checks assignable students, whole-number game counts 1–1,000, selected build availability or a nonempty manual detected style, actual calendar dates, ordered dates, a maximum 366-day inclusive range and a valid time zone.
- Inline errors appear on blur or submit attempt. Assign plan stays disabled while invalid. The visible Fix N fields action and Enter in an invalid input reveal all errors and focus the first invalid control in form order. API errors retain the populated draft and offer the existing retryable toast flow.
- Each student's last successfully assigned time zone is stored under `sc2tools:coaching:tz:<studentId>`. Reads and writes tolerate blocked storage. Invalid stored values fall back to the browser zone, then UTC. Remembered and browser zones appear first. Directly edited dates survive student/zone changes.
- Pure `assignmentSummary` states only the configured count, eligible 1v1 scope, build or repeating cadence, dates and time zone. Build targets remain one target across their date window; no weekly recurrence is invented for them. Invalid or incomplete drafts have no summary.
- The Wave 2 availability editor actually lives in `CoachSchedule.tsx`, so the control migration and `windowProblems` integration are there. Equal/reversed times, missing times and same-day overlaps block Publish; touching times and matching times on different days are valid. Editing a start time no longer remounts its input or sorts it away from keyboard focus.
- Removed the obsolete `fieldClass` helper and its unused import in `CoachingSchedule.tsx`. No presets, copy-to-days behavior, API schema changes, AI features or AI calls.

## Verification

- All coaching Vitest suites: 76 assertions across 9 files, including pure boundary tables, summary text, storage failures, inline descriptions, invalid-field focus, disabled submission, overlap recovery and failed API draft retention.
- Full web TypeScript; strict ESLint on every changed source/test; `git diff --check`.
- Production build with the exact CI environment (Reviews/Guides on, Instant Import all and engine required); every existing bundle budget unchanged and passing.
- Twelve Playwright scenarios at 375, 390, 430 and 1440 pixels using the actual coaching components and saved production CSS/fonts with explicitly intercepted local auth/API fixtures. Covers visible phone footer geometry, no horizontal overflow, per-student zone preselection and persistence, invalid-field focus, actual POST payloads, failed-save retries, blocked storage and corrected touching availability windows. No production requests or mutations.

The plan explicitly requires no new how-to article: inline hints and the live summary explain this form. A CHANGELOG entry is included. Availability templates and assignment reuse remain later roadmap work.
