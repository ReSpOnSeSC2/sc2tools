# Wave 2 installer/autostart checkpoint

Branch codex/wave2-agent-installer, separately stacked on runtime PR #668.
Scope agent-installer-autostart: one Run startup mechanism, legacy migration,
installer startup/desktop options, silent choice preservation, Finish Launch now,
opt-in named local-data removal, and two-stage signing preparation.

Verification on checkpoint 10beea26: full Windows suite 2,086 passed,
1 skipped, 78 subtests (175.36 s); download/help tests 75 passed; web typecheck,
lint, help index and exact-CI production build/all unchanged budgets passed.
The 22 focused startup/packaging checks include actual NSIS fixture compilation
and signature-verifier rejection cases.

A real unsigned PyInstaller bundle and NSIS setup built successfully; the
packaged Qt 6.12.0 diagnostic painted the window and Streams page offline.
No installer has been executed or published. The external pip cache was
inaccessible; the isolated build uses a workspace-local cache instead.

The SignPath Foundation workflow is prepared and pinned to official v3.0.
Owner-approved project/certificate, API token and repository variables are still
required. No signature has been requested or claimed. Tagged release builds will
fail closed without configured signing. No version bump, tag or publication.

Native runtime arrow contrast/main integration and a package-only byte-preservation
check remain before the draft opens. No AI feature/call and no application infrastructure change.
