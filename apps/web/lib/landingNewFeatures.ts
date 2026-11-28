/**
 * What the landing page's "What's new" section shows. Each card says what a
 * visitor can do once the chain behind it is merged, and where it only works
 * in the Windows desktop app it names the release that carries it.
 *
 * Availability is the honest label, not decoration:
 *   live    - works on the site as soon as it is deployed
 *   desktop - needs the Windows desktop app, 0.26.0 or later
 *   soon    - built, but behind a switch the owner has not turned on
 * Pictures are renders of the real interface with sample data and no names.
 * A picture with a `dark` file has a light and a dark render and follows the
 * site theme; one without is the desktop app, which is dark in both themes.
 */
export type NewFeatureAvailability = "live" | "desktop" | "soon";

export const AVAILABILITY_LABELS: Record<NewFeatureAvailability, string> = {
  live: "Live now",
  desktop: "Desktop app 0.26.0",
  soon: "Coming soon",
};

/**
 * feature - two columns: text beside a portrait picture from the medium breakpoint
 * tile    - one of a row of three, picture above the text
 * wide    - a landscape picture beside the text from the large breakpoint
 */
export type NewFeatureCardSize = "feature" | "tile" | "wide";

export interface NewFeatureImage {
  /** Light-theme file, or the only file when `dark` is absent. */
  src: string;
  dark?: string;
  /** Pixel size of the files, so the frame is reserved before they load. */
  width: number;
  height: number;
  alt: string;
  /** The picture is cut off at the bottom: fade it into the card instead of ending at a hard edge. */
  fade?: boolean;
}

export interface NewFeatureCard {
  id: string;
  size: NewFeatureCardSize;
  availability: NewFeatureAvailability;
  title: string;
  text: string;
  /** A second availability a card also has, such as a part still switched off. */
  note?: string;
  image: NewFeatureImage;
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
    columns: 1,
    cards: [
      {
        id: "randomizer-draws",
        size: "feature",
        availability: "live",
        title: "Draw a build, your opening units, or both.",
        text: "For every race, each matchup has two separate switches: one draws a build order, the other draws your first units. Units are picked from what that matchup's builds actually open with, and a Random player is drawn for the race they got.",
        image: {
          src: "/landing/whats-new-randomizer-light.png", dark: "/landing/whats-new-randomizer-dark.png", width: 336, height: 494, fade: true,
          alt: "Randomizer settings for a Protoss player: three matchup cards, then a Draw a build order switch and a Draw opening units switch, both on, using sample data",
        },
        link: { href: "/help/randomizer", label: "How the Randomizer works" },
      },
      {
        id: "randomizer-loading-card",
        size: "feature",
        availability: "desktop",
        title: "See the draw on your own screen.",
        text: "The loading card shows the build steps and the opening units your Randomizer drew, and keeps them in the Locked in bar. The desktop cards also repaint far less while you play.",
        image: {
          src: "/landing/whats-new-loading-card.png", width: 356, height: 409,
          alt: "Desktop loading card for a game against an opponent with a drawn two gate build, its timed steps and the opening pair of units",
        },
        link: { href: "/help/randomizer#desktop-draw", label: "The draw on your screen" },
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
          src: "/landing/whats-new-tags.png", width: 640, height: 320,
          alt: "Streams page group of switches that run at each game start: refresh the title, set channel tags, set the category and add an OBS recording chapter",
        },
        link: { href: "/help/desktop-stream-titles#channel-tags", label: "Set up tags" },
      },
      {
        id: "stream-guardian",
        size: "tile",
        availability: "desktop",
        title: "Catch a muted mic before chat does.",
        text: "Four optional warnings: a microphone muted while you are live, dropped frames, a game that starts while OBS is neither streaming nor recording, and a break scene left on. Each is a quiet tray notice and a banner in the Stream Dock.",
        image: {
          src: "/landing/whats-new-guardian.png", width: 760, height: 380,
          alt: "Stream Guardian card with four warning switches: microphone muted, frames dropping, game started with OBS not live or recording, and a break scene left on",
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
          src: "/landing/whats-new-chapters-light.png", dark: "/landing/whats-new-chapters-dark.png", width: 372, height: 186,
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
          src: "/landing/whats-new-live-light.png", dark: "/landing/whats-new-live-dark.png", width: 784, height: 512,
          alt: "Live StarCraft II streams page: platform, language and order filters above cards of sample channels with titles and viewer counts",
        },
        link: { href: "/help/live-streams", label: "About Live streams" },
      },
    ],
  },
];
