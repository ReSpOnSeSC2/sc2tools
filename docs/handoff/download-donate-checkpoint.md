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
Full web suite and actual browser verification are running/pending. No signing assertion, version bump, release/tag/install,
AI feature/API call, new infrastructure, donation or production account mutation.
The INSTALLER_SIGNED flag stays false pending actual signed-artifact verification.
