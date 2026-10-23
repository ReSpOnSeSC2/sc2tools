# Game header and completed check-ins

Completes `game-page-polish-3` on main `da80e233`. The hero uses the shared feature Card, a descriptive plain-text heading, labelled date/time and an optional linked opponent identity. Missing duration, MMR and opponent facts are omitted. OpponentLink supports future replay-row callers without making the heading a link.

One compact toolbar orders Share, Download, Ask for review and VOD. Download styling is opt-in, explicit custom review-button classes remain supported, and existing VOD chips stay the default. The header uses one timestamped VOD link or a portalled, viewport-bounded keyboard menu with focus return and unchanged HTTPS/provider validation.

Confirmed own/opponent check-ins start with a compact summary and a whitespace-normalized, Unicode-safe 140-character saved-note preview. Edit focuses the original controls. Writes keep an active editor open. Done requires saving/discarding a dirty note and returns focus to Edit. Pending/unchecked/ineligible/error states, new-build deep links and planned/corrected hero badges remain covered.

Validation: 188 assertions in 21 check-in/game/action suites; full web typecheck and strict changed-source lint; exact CI production build and all unchanged budgets. Landing 214/215 kB, dashboard 234.9/240, game 422.9/440, dossier 486/500, community 182.2/190, guides 171.5/175. Twenty-four browser checks at 390, 768 and 1440 pixels cover action order, overflow, VOD keyboard/viewport behavior, note save/collapse/focus and absent metadata. Four inspected screenshots are committed. The fixture uses actual components, production CSS/fonts and explicit sample auth/API boundaries, not a live account. Help build-check-in and its generated index were updated.

No migration, environment variable, release, signing or production mutation is required or performed. No AI features or API calls were added. Wave 3 macro workspace/shared clock/export work remains separate.

Final CI exposed an inherited Community history race. The browser restored URL parameters before cached server props; an obsolete draft could then replace the history entry. CommunityFilterBar now acknowledges the client URL before effects, preserving newer typing only for its own pending navigation. Two deterministic regressions cover delayed commits and stale server props; all12 filter tests pass. The production build/budgets pass and the real Clear-all/Back/Forward flow passed18 repeated tests across three widths. Root reviewed and merged ops-console #689 (main37736a0b); final combined GitHub CI remains pending.
