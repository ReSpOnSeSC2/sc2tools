/**
 * The help center's "Popular" list, in display order: the articles most
 * people need first. Slugs that don't exist are skipped, so removing an
 * article never breaks the hub (the article tests still flag it).
 */
export const POPULAR_HELP_SLUGS: readonly string[] = [
  "getting-started",
  "build-check-in",
  "obs-overlay-setup",
  "multi-platform-chat",
  "troubleshooting-and-support",
];
