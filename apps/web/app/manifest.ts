import type { MetadataRoute } from "next";

/** Matches the root layout's viewport themeColor and the dark --bg token. */
const APP_BACKGROUND = "#06090e";

/** Shortcut icon: the launcher shows it next to each shortcut's name. */
const SHORTCUT_ICONS = [
  { src: "/icons/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
];

/**
 * Web app manifest (served at /manifest.webmanifest).
 *
 * The installed app opens on Today (`/app`). `id` is fixed to "/app" so
 * the install keeps its identity if `start_url`'s query ever changes;
 * `?source=pwa` lets analytics tell app launches from browser visits.
 * Orientation is left to the device so tables and charts can use
 * landscape. Shortcuts (long-press the icon on Android, right-click it
 * on desktop) jump straight to the four most-used places.
 *
 * Help: lib/help/articles/getting-started/install-app.ts.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app",
    name: "SC2 Tools — opponent intel & live overlay",
    short_name: "SC2 Tools",
    description:
      "Opponent intel, build orders, and a live OBS overlay for StarCraft II — across every device.",
    start_url: "/app?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    categories: ["games", "utilities", "productivity"],
    icons: [
      {
        src: "/icons/pwa/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/pwa/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/pwa/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/pwa/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "Today",
        short_name: "Today",
        description: "Your session, streak and MMR at a glance.",
        url: "/app",
        icons: SHORTCUT_ICONS,
      },
      {
        name: "Opponents",
        short_name: "Opponents",
        description: "Everyone you've played, with head-to-head records.",
        url: "/app/opponents",
        icons: SHORTCUT_ICONS,
      },
      {
        name: "Replays",
        short_name: "Replays",
        description: "Your replay library.",
        url: "/app/replays",
        icons: SHORTCUT_ICONS,
      },
      {
        name: "Stream settings",
        short_name: "Stream",
        description: "Overlay links and widget settings for OBS.",
        url: "/settings?tab=overlay",
        icons: SHORTCUT_ICONS,
      },
    ],
  };
}
