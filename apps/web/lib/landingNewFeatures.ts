/**
 * What the landing page's "What's new" section shows. Each card says what a
 * visitor can do once the chain behind it is merged, and where it only works
 * in the Windows desktop app it names the release that carries it.
 *
 * Availability is the honest label, not decoration:
 *   live    - works on the site as soon as it is deployed
 *   desktop - needs the Windows desktop app, 0.26.0 or later
 *   soon    - built, but behind a switch the owner has not turned on
 * Pictures are crops of the real interface with sample data and no names.
 */
export type NewFeatureAvailability = "live" | "desktop" | "soon";

export const AVAILABILITY_LABELS: Record<NewFeatureAvailability, string> = {
  live: "Live now",
  desktop: "Desktop app 0.26.0",
  soon: "Coming soon",
};

export type NewFeatureCardSize = "lead" | "tile" | "wide";

export interface NewFeatureCard {
  id: string;
  size: NewFeatureCardSize;
  availability: NewFeatureAvailability;
  title: string;
  text: string;
  /** A second availability a card also has, such as a part still switched off. */
  note?: string;
  image: { src: string; width: number; height: number; alt: string };
  link: { href: string; label: string };
}

export interface NewFeatureGroup {
  id: string;
  title: string;
  /** Columns the group's cards share from the large breakpoint up. */
  columns: 1 | 3;
  cards: readonly NewFeatureCard[];
}

export const NEW_FEATURE_GROUPS: readonly NewFeatureGroup[] = [
  {
    id: "randomizer",
    title: "Randomizer",
    columns: 3,
    cards: [
      {
        id: "randomizer-draws",
        size: "lead",
        availability: "live",
        title: "Draw a build, your opening units, or both.",
        text: "For every race, each matchup has two separate switches: one draws a build order, the other draws your first units. Units are picked from what that matchup's builds actually open with, and a Random player is drawn for the race they got.",
        image: {
          src: "/landing/whats-new-randomizer.png", width: 980, height: 400,
          alt: "Randomizer settings for a Protoss player with a build order switch and an opening units switch, both on, using sample data",
        },
        link: { href: "/help/randomizer", label: "How the Randomizer works" },
      },
      {
        id: "randomizer-loading-card",
        size: "tile",
        availability: "desktop",
        title: "See the draw on your own screen.",
        text: "The loading card shows the build steps and the opening units your Randomizer drew, and keeps them in the Locked in bar. The desktop cards also repaint far less while you play.",
        image: {
          src: "/landing/whats-new-loading-card.png", width: 380, height: 190,
          alt: "Desktop loading card for a game against an opponent with a drawn two gate build, its timed steps and the opening pair of units",
        },
        link: { href: "/help/randomizer", label: "Randomizer guide" },
      },
    ],
  },
  {
    id: "stream-tools",
    title: "Stream tools",
    columns: 3,
    cards: [
      {
        id: "stream-tags",
        size: "tile",
        availability: "desktop",
        title: "Tags and category, set at game start.",
        text: "Twitch and Kick channel tags (matchup, race, league) and the StarCraft II category update when a game begins. Both switches start off, and tags you set yourself are kept.",
        image: {
          src: "/landing/whats-new-tags.png", width: 480, height: 240,
          alt: "Streams page group of switches that run at each game start: refresh the title, set channel tags, set the category and add an OBS recording chapter",
        },
        link: { href: "/help/desktop-stream-titles#channel-tags", label: "Set up tags" },
      },
      {
        id: "stream-guardian",
        size: "tile",
        availability: "desktop",
        title: "Catch a muted mic before chat does.",
        text: "Four optional warnings while you are live: a muted microphone, dropped frames, a game with OBS not streaming, and a break scene left on. Each is a silent tray notice and a banner in the Stream Dock.",
        image: {
          src: "/landing/whats-new-guardian.png", width: 480, height: 240,
          alt: "Stream Guardian card with four warning switches: microphone muted, frames dropping, game started with OBS not live, and a break scene left on",
        },
        link: { href: "/help/stream-guardian", label: "About Stream Guardian" },
      },
      {
        id: "game-chapters",
        size: "tile",
        availability: "live",
        title: "A chapter for every game.",
        text: "Show and copy a timestamped list of the day's games from the Stream Dock, ready for a Twitch or Kick description. The desktop app 0.26.0 can also add an OBS recording chapter at each game start.",
        note: "Writing the list into your YouTube archive is coming soon.",
        image: {
          src: "/landing/whats-new-chapters.png", width: 310, height: 155,
          alt: "Stream Dock buttons to show and copy game chapters above a list of three sample games with their start times and results",
        },
        link: { href: "/help/game-chapters", label: "About game chapters" },
      },
    ],
  },
  {
    id: "live",
    title: "Live",
    columns: 1,
    cards: [
      {
        id: "live-streams",
        size: "wide",
        availability: "soon",
        title: "Find a StarCraft II stream to watch.",
        text: "One public page lists every StarCraft II channel live on Twitch and Kick. Filter by platform and language, or put small channels first to find someone with room for a new viewer. It switches on once its Twitch and Kick connections are set up.",
        image: {
          src: "/landing/whats-new-live.png", width: 1000, height: 432,
          alt: "Live StarCraft II streams page with platform, language and order filters above cards showing sample channels, titles and viewer counts",
        },
        link: { href: "/help/live-streams", label: "About Live streams" },
      },
    ],
  },
];
