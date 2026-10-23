# Wave 2 installer/autostart checkpoint

Branch codex/wave2-agent-installer, separately stacked on runtime PR #668.
Scope agent-installer-autostart: one Run startup mechanism, legacy migration,
installer startup/desktop options, silent choice preservation, Finish Launch now,
opt-in named local-data removal, and two-stage signing preparation.

Final desktop source verification includes the actual asynchronous settings-save
fix from runtime: 2,087 Windows tests passed, 1 skipped, 78 subtests (151.81 s).
The native regression holds the real state-writer lock while Qt timers/navigation
continue and checks the actual durable commit before Saved feedback. The final
startup/packaging subset passes 26 checks, including real NSIS fixture compilation
and signature-verifier rejection cases. Download/help tests: 75 passed; typecheck,
lint, help index and exact-CI production build/all unchanged budgets passed.

A final real unsigned PyInstaller bundle and NSIS setup built successfully;
the packaged Qt 6.12.0 diagnostic painted the window and Streams page offline.
Package-only preserved the inner executable SHA-256 and last-write timestamp.
Setup size 226,252,645 bytes; SHA-256:
`98067fcba10ceba20c3216d5bc841c60dd24729ecd9a85fc82af2148ed70a106`.
Windows reports `NotSigned`. No installer was executed or published. The build
uses an isolated virtualenv and workspace-local pip cache.

The SignPath Foundation workflow is prepared and pinned to official v3.0.
Owner-approved project/certificate, API token and repository variables are still
required. No signature has been requested or claimed. Tagged release builds will
fail closed without configured signing. No version bump, tag or publication.

Runtime and newest-main integration are kept current before the draft opens.
Actual interactive install/uninstall and a real signed provider run remain owner
release validation on a disposable Windows profile. No AI feature/call and no application infrastructure change.
