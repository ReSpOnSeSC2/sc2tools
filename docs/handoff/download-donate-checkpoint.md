# Wave 2 download/donation checkpoint

Scope: settings-onboarding-polish-3, full spec/howto, no augments.
Isolated branch codex/wave2-download-donate from What's New #671 head07d6bca7,
merged frozen installer #672 (parent-updated ecb3035e) at8a046ec6. Those pending
parents remain separate; no runtime/installer or owner-checkout edits.

Implemented source changes: error/empty release states; shared truthful unsigned
installer copy and selected-OS venv snippets; conditional signed-in archive note
and installed-version line; no hard-coded size fallback; existing MiniMarkdown
notes preserved behind accessible toggle plus All releases. Donate has a plain
hero, provider cost bar, collapsed measurement details, ordinary icons and a
copy-email control with selection fallback. Install/link help gains Retry/GitHub.

Affected verification passed 130 checks across24 suites, including the final
release loading/size guards, inherited safe markdown and help contracts. Web
typecheck and strict changed-file lint pass. Exact-CI production build and all
unchanged budgets pass (/app233.8/240 kB, opponents175.8/180, guides169.8/175).
Full web suite passed: 6,285 tests, 1 skipped across 658 suites. Actual Chromium
checks passed at 390 and 1440 px with production CSS/fonts and fixture data:
error/Retry vs empty release, OS command switching, safe release notes, conditional
account notices, donation cost totals, copy and denied-clipboard selection,
light/dark layouts, no horizontal overflow and no browser errors. Browser checks
caught a grid min-content overflow with manual commands expanded on phones; the
grid now uses shrinkable tracks and the command block scrolls within its card.
Five reviewed screenshots are in docs/handoff/screenshots/download-polish-* and
donate-polish-*. Grid correction focused tests passed 2/2. No signing assertion, version bump, release/tag/install,
AI feature/API call, new infrastructure, donation or production account mutation.
The INSTALLER_SIGNED flag stays false pending actual signed-artifact verification.

The draft targets codex/wave2-download-donate-deps (the dependency-only merge at
8a046ec6) so its diff stays focused. Root must integrate #671 and #672 and their
parents, then retarget this draft to main and rerun final remote integration CI.

Remote CI found an inherited notification focus race (the panel could focus its
empty header before returned rows were merged). Applied the notification owner's
3a03620a fix as54ff57c6: readiness now waits for committed rows and layout-effect
focus. All15 bell integration tests and the new deterministic panel regression
pass. Responsive smoke/build/budgets were already green; remote web CI reruns.
