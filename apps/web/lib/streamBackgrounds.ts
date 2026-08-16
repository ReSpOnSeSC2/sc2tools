/**
 * Broadcast-ready virtual sets exported under ``public/stream-backgrounds``.
 *
 * Keep filenames and stable scene IDs together here. Both the OBS scene route
 * and the Stream Dock fallback player consume this catalog, so adding a future
 * set is a one-entry operation rather than a collection of string allowlists.
 */

type StreamBackgroundDefinition = {
  id: string;
  label: string;
  description: string;
  src1080: `/stream-backgrounds/1080p/${string}.jpg`;
  src4k: `/stream-backgrounds/4k/${string}.jpg`;
  /** CSS object-position chosen to preserve the intended camera-safe framing. */
  objectPosition: `${number}% ${number}%`;
  /** Paint shown only during the first image decode in OBS. */
  canvasColor: `#${string}`;
};

export const STREAM_BACKGROUNDS = [
  {
    id: "frontier-cantina",
    label: "Frontier Cantina",
    description:
      "A lived-in deep-space cantina with warm practical light, quiet booths and a broad camera-ready bar set.",
    src1080: "/stream-backgrounds/1080p/01-frontier-cantina.jpg",
    src4k: "/stream-backgrounds/4k/01-frontier-cantina.jpg",
    objectPosition: "50% 50%",
    canvasColor: "#110b09",
  },
  {
    id: "renegade-battlecruiser-bridge",
    label: "Renegade Battlecruiser Bridge",
    description:
      "A rugged capital-ship command deck framed by armored consoles, cold starlight and a cinematic forward viewport.",
    src1080:
      "/stream-backgrounds/1080p/02-renegade-battlecruiser-bridge.jpg",
    src4k: "/stream-backgrounds/4k/02-renegade-battlecruiser-bridge.jpg",
    objectPosition: "50% 48%",
    canvasColor: "#07121b",
  },
  {
    id: "orbital-station-concourse",
    label: "Orbital Station Concourse",
    description:
      "An immense orbital concourse with layered windows, distant traffic and a clean central broadcast position.",
    src1080:
      "/stream-backgrounds/1080p/03-orbital-station-concourse.jpg",
    src4k: "/stream-backgrounds/4k/03-orbital-station-concourse.jpg",
    objectPosition: "50% 50%",
    canvasColor: "#07131d",
  },
  {
    id: "interstellar-broadcast-studio",
    label: "Interstellar Broadcast Studio",
    description:
      "A polished on-air studio with a sweeping news desk, orbital sightlines and cool professional lighting.",
    src1080:
      "/stream-backgrounds/1080p/04-interstellar-broadcast-studio.jpg",
    src4k: "/stream-backgrounds/4k/04-interstellar-broadcast-studio.jpg",
    objectPosition: "50% 50%",
    canvasColor: "#071019",
  },
  {
    id: "volcanic-world-overlook",
    label: "Volcanic World Overlook",
    description:
      "A fortified command overlook above a volcanic war-world, lit by magma, ash and distant industrial silhouettes.",
    src1080:
      "/stream-backgrounds/1080p/05-volcanic-world-overlook.jpg",
    src4k: "/stream-backgrounds/4k/05-volcanic-world-overlook.jpg",
    objectPosition: "50% 48%",
    canvasColor: "#170806",
  },
  {
    id: "ancient-carrier-sanctuary",
    label: "Ancient Carrier Sanctuary",
    description:
      "A serene carrier interior of ancient gold architecture, crystalline energy and an expansive celestial window.",
    src1080:
      "/stream-backgrounds/1080p/06-ancient-carrier-sanctuary.jpg",
    src4k: "/stream-backgrounds/4k/06-ancient-carrier-sanctuary.jpg",
    objectPosition: "50% 50%",
    canvasColor: "#100d20",
  },
  {
    id: "psionic-mothership-nexus",
    label: "Psionic Mothership Nexus",
    description:
      "A vast psionic nexus chamber suspended inside a mothership, alive with violet energy and impossible scale.",
    src1080:
      "/stream-backgrounds/1080p/07-psionic-mothership-nexus.jpg",
    src4k: "/stream-backgrounds/4k/07-psionic-mothership-nexus.jpg",
    objectPosition: "50% 50%",
    canvasColor: "#0d0920",
  },
] as const satisfies readonly StreamBackgroundDefinition[];

export type StreamBackground = (typeof STREAM_BACKGROUNDS)[number];
export type StreamBackgroundId = StreamBackground["id"];

export const STREAM_BACKGROUND_IDS: readonly StreamBackgroundId[] =
  STREAM_BACKGROUNDS.map((background) => background.id);

const STREAM_BACKGROUND_ID_SET: ReadonlySet<string> = new Set(
  STREAM_BACKGROUND_IDS,
);

export function isStreamBackgroundId(value: string): value is StreamBackgroundId {
  return STREAM_BACKGROUND_ID_SET.has(value);
}

export function getStreamBackground(id: StreamBackgroundId): StreamBackground {
  // The ID type and catalog derive from the same readonly tuple, so this lookup
  // is exhaustive. Keeping it as a function gives callers one stable API even
  // if the catalog storage changes later.
  return STREAM_BACKGROUNDS.find((background) => background.id === id)!;
}
