# V1b · Agent interface pages

- **Shipped.** Recent games, Activity log, Settings and Help share the Agent 0.25.0 theme across all four skins. Recent games and Activity log scroll at 480 × 360. Build check-in previews wrap inside Settings. Labels use “and” where Qt treated the ampersand as a keyboard shortcut.
- **Review.** Fixed all four findings. Enter and F3 scroll the selected log match into view while typing stays in place. Scroll-area layouts are installed before Qt receives the content widget. Minimum-window tests exercise nested controls at 125% and 150% scaling. The README names the matching Agent menu action.
- **Tests.** 231 Agent tests in 17 files and 60 web tests in seven files passed. TypeScript, scoped ESLint, 24 ui-lint rules, ui-lint, and the whitespace check passed.
- **Mutations.** 10 of 10 killed in `C:/SC2TOOLS/.cache/growth-V1b-tools/mutation-codex-02/`. The first run missed the recent-table minimum. The test now checks that the list reserves its minimum height.
- **Pictures.** Five inspected contact sheets under `C:/SC2TOOLS/.cache/growth-V1b-tools/`: `codex-v1b-final-recent.png`, `codex-v1b-final-log.png`, `codex-v1b-final-log-match.png`, `codex-v1b-settings.png`, `codex-v1b-help.png`. All four skins at 480 × 360 and 1100 × 760.
- **Not verified.** Installed Agent and StarCraft II behavior. GitHub checks run on the updated pull request.
- **Follow-up.** V1e includes these pages in the Agent gallery.
