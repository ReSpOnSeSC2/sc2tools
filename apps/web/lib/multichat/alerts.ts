/* eslint-disable max-lines -- this module is primarily one declarative preset catalog */
// Visual alert presets for the on-stream event toaster.
//
// The shipped catalog is code-native or uses licensed local icons: renderers
// compose typography, emoji, gradients and CSS decorations without fetching
// third-party meme images. The metadata also supports locally hosted rendered
// animation assets when licensed files are added. Stable ids are persisted in
// the multichat preferences blob, so ids must never be renamed once shipped.

import {
  CHAT_EVENT_KINDS,
  type ChatEventKind,
} from "./events";

export const ALERT_VISUAL_CATEGORIES = [
  "Core",
  "Reaction",
  "Frog",
  "Money",
  "Hype",
  "Wholesome",
  "StarCraft",
  "Chaos",
  "Meme",
] as const;

export type AlertVisualCategory = (typeof ALERT_VISUAL_CATEGORIES)[number];

export const ALERT_VISUAL_LAYOUTS = [
  "card",
  "lower-third",
  "pill",
  "burst",
  "spotlight",
  "stage",
] as const;

export type AlertVisualLayout = (typeof ALERT_VISUAL_LAYOUTS)[number];

export const ALERT_VISUAL_ENTRIES = [
  "pop",
  "slide-up",
  "slide-left",
  "drop",
  "zoom",
  "bounce",
  "spin",
  "glitch",
  "rise",
  "stamp",
] as const;

export type AlertVisualEntry = (typeof ALERT_VISUAL_ENTRIES)[number];

export type AlertVisualDecoration =
  | "platform-chip"
  | "scanlines"
  | "sparkles"
  | "confetti"
  | "speed-lines"
  | "hearts"
  | "coins"
  | "bills"
  | "stars"
  | "crowd"
  | "lightning"
  | "smoke"
  | "halftone"
  | "pixels"
  | "glitch"
  | "frogs"
  | "crown"
  | "spotlight"
  | "warning-stripes"
  | "meteors";

export interface AlertVisualPresetShape {
  readonly id: string;
  readonly label: string;
  readonly category: AlertVisualCategory;
  readonly description: string;
  readonly emoji: string;
  readonly callout: string;
  readonly layout: AlertVisualLayout;
  readonly entry: AlertVisualEntry;
  readonly decorations: readonly AlertVisualDecoration[];
  /** Primary and secondary CSS colours used by a renderer's gradients/glow. */
  readonly accent: string;
  readonly accentAlt: string;
  /** Optional existing, locally licensed SC2 icon. Never a remote URL. */
  readonly assetUrl?: string;
  /** Optional transparent, locally hosted video animation (for example WebM). */
  readonly animationUrl?: string;
  /** Static image shown while loading, on failure, or for reduced motion. */
  readonly animationPosterUrl?: string;
  /**
   * Restricts the preset to admin accounts. Set on the rendered SC2 3D
   * presets: their media is derived from rights-controlled game assets, is
   * never bundled into the public build, and is only reachable through the
   * admin-gated presign endpoint. Non-admins do not see these in the picker
   * and the renderer falls back to the code-native static art.
   */
  readonly adminOnly?: boolean;
}

/**
 * Original visual treatments for alert cards. The catalog deliberately keeps
 * all fields declarative so the OBS renderer and a Settings preview can share
 * one implementation without loading remote art.
 */
const ALERT_VISUAL_PRESET_DEFINITIONS = [
  // Core
  {
    id: "classic",
    label: "Classic",
    category: "Core",
    description: "The original SC2 Tools alert card with a crisp accent rail.",
    emoji: "✦",
    callout: "NEW ALERT",
    layout: "card",
    entry: "pop",
    decorations: ["platform-chip"],
    accent: "#3ec0c7",
    accentAlt: "#8be9ef",
  },
  {
    id: "clean-lower-third",
    label: "Clean Lower Third",
    category: "Core",
    description: "A broadcast-style lower third that keeps gameplay readable.",
    emoji: "🔔",
    callout: "WELCOME IN",
    layout: "lower-third",
    entry: "slide-up",
    decorations: ["platform-chip", "sparkles"],
    accent: "#58c7f3",
    accentAlt: "#d9f5ff",
  },
  {
    id: "neon-card",
    label: "Neon Card",
    category: "Core",
    description: "Electric cyan and violet edges with a restrained neon glow.",
    emoji: "💠",
    callout: "LIVE NOW",
    layout: "card",
    entry: "zoom",
    decorations: ["scanlines", "sparkles"],
    accent: "#25f4ee",
    accentAlt: "#a855f7",
  },
  {
    id: "minimal-pill",
    label: "Minimal Pill",
    category: "Core",
    description: "A compact single-line acknowledgement for dense scenes.",
    emoji: "●",
    callout: "THANK YOU",
    layout: "pill",
    entry: "slide-left",
    decorations: ["platform-chip"],
    accent: "#94a3b8",
    accentAlt: "#f8fafc",
  },
  {
    id: "pixel-panel",
    label: "Pixel Panel",
    category: "Core",
    description: "A chunky arcade notification built from pixel-like blocks.",
    emoji: "👾",
    callout: "PLAYER JOINED",
    layout: "card",
    entry: "stamp",
    decorations: ["pixels", "scanlines"],
    accent: "#22c55e",
    accentAlt: "#facc15",
  },
  {
    id: "comic-burst",
    label: "Comic Burst",
    category: "Core",
    description: "Halftone rays and oversized lettering for a clean comic hit.",
    emoji: "💥",
    callout: "NO WAY!",
    layout: "burst",
    entry: "pop",
    decorations: ["halftone", "speed-lines"],
    accent: "#ef4444",
    accentAlt: "#fde047",
  },

  // Reaction
  {
    id: "laughing-man",
    label: "Laughing Man",
    category: "Reaction",
    description: "An original code-native laughing reaction with bouncing type.",
    emoji: "😂",
    callout: "HE REALLY DID THAT",
    layout: "spotlight",
    entry: "bounce",
    decorations: ["halftone", "sparkles"],
    accent: "#fbbf24",
    accentAlt: "#fb7185",
  },
  {
    id: "mind-blown",
    label: "Mind Blown",
    category: "Reaction",
    description: "A radiant reaction burst for unexpectedly huge moments.",
    emoji: "🤯",
    callout: "ABSOLUTE CINEMA",
    layout: "burst",
    entry: "zoom",
    decorations: ["speed-lines", "stars"],
    accent: "#f97316",
    accentAlt: "#fde047",
  },
  {
    id: "chef-kiss",
    label: "Chef's Kiss",
    category: "Reaction",
    description: "A polished little flourish for immaculate support timing.",
    emoji: "🤌",
    callout: "PERFECT",
    layout: "card",
    entry: "rise",
    decorations: ["sparkles", "stars"],
    accent: "#f59e0b",
    accentAlt: "#fff7ed",
  },
  {
    id: "plot-twist",
    label: "Plot Twist",
    category: "Reaction",
    description: "A dramatic title-card flip for surprise redeems and gifts.",
    emoji: "😮",
    callout: "PLOT TWIST",
    layout: "stage",
    entry: "spin",
    decorations: ["spotlight", "speed-lines"],
    accent: "#e879f9",
    accentAlt: "#67e8f9",
  },

  // Frog — all six are original illustrated-in-CSS frog personas.
  {
    id: "frog-hype",
    label: "Hype Frog",
    category: "Frog",
    description: "An original wide-eyed frog hopping in to celebrate the alert.",
    emoji: "🐸",
    callout: "FROG MODE: ON",
    layout: "burst",
    entry: "bounce",
    decorations: ["frogs", "confetti"],
    accent: "#65a30d",
    accentAlt: "#bef264",
  },
  {
    id: "frog-sip",
    label: "Tea Frog",
    category: "Frog",
    description: "A calm original frog pauses for tea while the name lands.",
    emoji: "🐸",
    callout: "SIPS TEA",
    layout: "card",
    entry: "rise",
    decorations: ["frogs", "sparkles"],
    accent: "#15803d",
    accentAlt: "#fde68a",
  },
  {
    id: "frog-bonk",
    label: "Bonk Frog",
    category: "Frog",
    description: "A slapstick frog approval stamp with a cartoony impact ring.",
    emoji: "🐸",
    callout: "BONK OF APPROVAL",
    layout: "spotlight",
    entry: "stamp",
    decorations: ["frogs", "speed-lines"],
    accent: "#84cc16",
    accentAlt: "#fb923c",
  },
  {
    id: "frog-business",
    label: "Business Frog",
    category: "Frog",
    description: "A tiny tie, serious panel and very official frog approval.",
    emoji: "🐸",
    callout: "BUSINESS FROG APPROVES",
    layout: "lower-third",
    entry: "slide-up",
    decorations: ["frogs", "platform-chip"],
    accent: "#166534",
    accentAlt: "#93c5fd",
  },
  {
    id: "frog-party",
    label: "Party Frog",
    category: "Frog",
    description: "A chorus of original dancing frogs and celebratory confetti.",
    emoji: "🐸",
    callout: "RIBBIT RAVE",
    layout: "stage",
    entry: "bounce",
    decorations: ["frogs", "confetti", "stars"],
    accent: "#22c55e",
    accentAlt: "#f472b6",
  },
  {
    id: "frog-oracle",
    label: "Oracle Frog",
    category: "Frog",
    description: "A mystical original frog predicts the support before it lands.",
    emoji: "🐸",
    callout: "THE FROG FORETOLD THIS",
    layout: "spotlight",
    entry: "zoom",
    decorations: ["frogs", "sparkles", "stars"],
    accent: "#7c3aed",
    accentAlt: "#86efac",
  },

  // Money
  {
    id: "cash-pop",
    label: "Cash Pop",
    category: "Money",
    description: "One oversized dollar bill pops up, wobbles and settles.",
    emoji: "💵",
    callout: "CASH HAS ENTERED CHAT",
    layout: "spotlight",
    entry: "pop",
    decorations: ["bills", "sparkles"],
    accent: "#16a34a",
    accentAlt: "#bbf7d0",
  },
  {
    id: "money-rain",
    label: "Money Rain",
    category: "Money",
    description: "A shower of code-drawn bills falls behind the supporter name.",
    emoji: "💸",
    callout: "MAKE IT RAIN",
    layout: "stage",
    entry: "drop",
    decorations: ["bills", "coins"],
    accent: "#22c55e",
    accentAlt: "#facc15",
  },
  {
    id: "stonks",
    label: "Stonks",
    category: "Money",
    description: "A boldly rising chart celebrates numbers going the right way.",
    emoji: "📈",
    callout: "NUMBER GO UP",
    layout: "card",
    entry: "rise",
    decorations: ["sparkles", "speed-lines"],
    accent: "#10b981",
    accentAlt: "#60a5fa",
  },
  {
    id: "jackpot",
    label: "Jackpot",
    category: "Money",
    description: "Three bright reels snap into place on a celebratory jackpot.",
    emoji: "🎰",
    callout: "JACKPOT!",
    layout: "stage",
    entry: "spin",
    decorations: ["coins", "confetti", "stars"],
    accent: "#dc2626",
    accentAlt: "#facc15",
  },
  {
    id: "cash-register",
    label: "Cash Register",
    category: "Money",
    description: "A snappy receipt-and-coins treatment with a cha-ching finish.",
    emoji: "🧾",
    callout: "CHA-CHING",
    layout: "lower-third",
    entry: "slide-up",
    decorations: ["coins", "platform-chip"],
    accent: "#059669",
    accentAlt: "#fef3c7",
  },
  {
    id: "gold-rush",
    label: "Gold Rush",
    category: "Money",
    description: "Warm gold coins streak inward and frame the alert amount.",
    emoji: "🪙",
    callout: "GOLD RUSH",
    layout: "burst",
    entry: "zoom",
    decorations: ["coins", "speed-lines"],
    accent: "#d97706",
    accentAlt: "#fde68a",
  },

  // Hype
  {
    id: "airhorn",
    label: "Airhorn",
    category: "Hype",
    description: "A loud-looking horn blast rendered as punchy graphic waves.",
    emoji: "📣",
    callout: "BWAAAP!",
    layout: "burst",
    entry: "pop",
    decorations: ["speed-lines", "lightning"],
    accent: "#ef4444",
    accentAlt: "#facc15",
  },
  {
    id: "boss-entrance",
    label: "Boss Entrance",
    category: "Hype",
    description: "A cinematic health-bar entrance for a major supporter arrival.",
    emoji: "⚔️",
    callout: "BOSS INCOMING",
    layout: "stage",
    entry: "slide-left",
    decorations: ["smoke", "spotlight", "lightning"],
    accent: "#dc2626",
    accentAlt: "#a78bfa",
  },
  {
    id: "arena-roar",
    label: "Arena Roar",
    category: "Hype",
    description: "Stadium lights and a crowd-wave silhouette fill the frame.",
    emoji: "🏟️",
    callout: "CROWD GOES WILD",
    layout: "stage",
    entry: "rise",
    decorations: ["crowd", "spotlight", "confetti"],
    accent: "#2563eb",
    accentAlt: "#f8fafc",
  },
  {
    id: "level-up",
    label: "Level Up",
    category: "Hype",
    description: "An arcade rank-up flash that makes a new supporter feel earned.",
    emoji: "⬆️",
    callout: "LEVEL UP!",
    layout: "card",
    entry: "rise",
    decorations: ["pixels", "stars", "sparkles"],
    accent: "#06b6d4",
    accentAlt: "#a3e635",
  },
  {
    id: "raid-boss",
    label: "Raid Boss",
    category: "Hype",
    description: "A giant incoming-party banner made specifically for raids.",
    emoji: "🐲",
    callout: "RAID PARTY DETECTED",
    layout: "stage",
    entry: "zoom",
    decorations: ["warning-stripes", "smoke", "lightning"],
    accent: "#7c3aed",
    accentAlt: "#fb7185",
  },
  {
    id: "victory-lap",
    label: "Victory Lap",
    category: "Hype",
    description: "Checkered streaks and confetti carry the name across the line.",
    emoji: "🏁",
    callout: "LET'S GOOO",
    layout: "lower-third",
    entry: "slide-left",
    decorations: ["speed-lines", "confetti"],
    accent: "#0f172a",
    accentAlt: "#f8fafc",
  },

  // Wholesome
  {
    id: "heart-bloom",
    label: "Heart Bloom",
    category: "Wholesome",
    description: "Soft hearts bloom outward around a warm thank-you card.",
    emoji: "💖",
    callout: "BIG LOVE",
    layout: "card",
    entry: "pop",
    decorations: ["hearts", "sparkles"],
    accent: "#ec4899",
    accentAlt: "#fbcfe8",
  },
  {
    id: "cozy-welcome",
    label: "Cozy Welcome",
    category: "Wholesome",
    description: "A warm, low-key welcome with a softly glowing edge.",
    emoji: "☕",
    callout: "PULL UP A CHAIR",
    layout: "lower-third",
    entry: "rise",
    decorations: ["sparkles", "platform-chip"],
    accent: "#c2410c",
    accentAlt: "#fed7aa",
  },
  {
    id: "gold-star",
    label: "Gold Star",
    category: "Wholesome",
    description: "A bright star badge awards the viewer for showing up.",
    emoji: "🌟",
    callout: "YOU'RE A STAR",
    layout: "spotlight",
    entry: "stamp",
    decorations: ["stars", "sparkles"],
    accent: "#eab308",
    accentAlt: "#fef9c3",
  },
  {
    id: "community-hug",
    label: "Community Hug",
    category: "Wholesome",
    description: "Layered heart rings bring the whole community into the moment.",
    emoji: "🤗",
    callout: "GROUP HUG",
    layout: "stage",
    entry: "zoom",
    decorations: ["hearts", "crowd"],
    accent: "#f472b6",
    accentAlt: "#c4b5fd",
  },
  {
    id: "confetti-thanks",
    label: "Confetti Thanks",
    category: "Wholesome",
    description: "A classic thank-you shower with colorful paper confetti.",
    emoji: "🎉",
    callout: "THANK YOU!",
    layout: "burst",
    entry: "bounce",
    decorations: ["confetti", "stars"],
    accent: "#14b8a6",
    accentAlt: "#f472b6",
  },
  {
    id: "tiny-crown",
    label: "Tiny Crown",
    category: "Wholesome",
    description: "A tiny crown drops neatly onto the supporter name.",
    emoji: "👑",
    callout: "ROYAL SUPPORTER",
    layout: "pill",
    entry: "drop",
    decorations: ["crown", "sparkles"],
    accent: "#a855f7",
    accentAlt: "#fde047",
  },

  // StarCraft — existing locally licensed icon assets plus CSS effects.
  {
    id: "mule-money-drop",
    label: "MULE Money Drop",
    category: "StarCraft",
    description: "A Terran MULE lands with a code-drawn shower of bonus minerals.",
    emoji: "💰",
    callout: "MULE MINING ONLINE",
    layout: "spotlight",
    entry: "drop",
    decorations: ["coins", "speed-lines", "smoke"],
    accent: "#3b82f6",
    accentAlt: "#facc15",
    assetUrl: "/icons/sc2/units/mule.png",
  },
  {
    id: "zergling-swarm",
    label: "Zergling Swarm",
    category: "StarCraft",
    description: "A pack of Zerglings rushes the frame around a major alert.",
    emoji: "🦎",
    callout: "SWARM INCOMING",
    layout: "stage",
    entry: "slide-left",
    decorations: ["speed-lines", "smoke", "crowd"],
    accent: "#a855f7",
    accentAlt: "#84cc16",
    assetUrl: "/icons/sc2/units/zergling.png",
  },
  {
    id: "battlecruiser-arrival",
    label: "Battlecruiser Arrival",
    category: "StarCraft",
    description: "A capital ship warps in like the support event is the final boss.",
    emoji: "🚀",
    callout: "BATTLECRUISER OPERATIONAL",
    layout: "stage",
    entry: "zoom",
    decorations: ["spotlight", "smoke", "lightning"],
    accent: "#dc2626",
    accentAlt: "#60a5fa",
    assetUrl: "/icons/sc2/units/battlecruiser.png",
  },
  {
    id: "protoss-warp-in",
    label: "Protoss Warp-In",
    category: "StarCraft",
    description: "Psionic rings resolve the supporter into the stream in a flash.",
    emoji: "🔷",
    callout: "WARP-IN COMPLETE",
    layout: "spotlight",
    entry: "zoom",
    decorations: ["sparkles", "lightning", "stars"],
    accent: "#06b6d4",
    accentAlt: "#facc15",
    assetUrl: "/icons/sc2/buildings/warpgate.png",
  },
  {
    id: "overlord-delivery",
    label: "Overlord Delivery",
    category: "StarCraft",
    description: "An Overlord floats in carrying an extremely important alert.",
    emoji: "📦",
    callout: "SPECIAL DELIVERY",
    layout: "lower-third",
    entry: "slide-up",
    decorations: ["smoke", "sparkles", "platform-chip"],
    accent: "#9333ea",
    accentAlt: "#f472b6",
    assetUrl: "/icons/sc2/units/overlord.png",
  },
  {
    id: "gg-fireworks",
    label: "GG Fireworks",
    category: "StarCraft",
    description: "A sportsmanlike GG detonates into celebratory code-native fireworks.",
    emoji: "🎆",
    callout: "GG WP",
    layout: "burst",
    entry: "pop",
    decorations: ["confetti", "stars", "sparkles"],
    accent: "#22d3ee",
    accentAlt: "#f472b6",
  },

  // Rendered 3D SC2 vignettes — transparent video with local icon fallback.
  {
    id: "zealot-dance-3d",
    label: "Zealot Victory Dance 3D",
    category: "StarCraft",
    description: "A fully rendered Zealot breaks into an earnest victory dance while golden psi blades trace the beat.",
    emoji: "🕺",
    callout: "MY LIFE FOR THE DANCE",
    layout: "stage",
    entry: "bounce",
    decorations: ["confetti", "sparkles", "stars"],
    accent: "#22d3ee",
    accentAlt: "#facc15",
    assetUrl: "/icons/sc2/units/zealot.png",
    animationUrl: "/alerts/sc2-3d/zealot-dance-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/zealot-dance-3d.webp",
    adminOnly: true,
  },
  {
    id: "marine-skyfire-3d",
    label: "Marine Skyfire Salute 3D",
    category: "StarCraft",
    description: "A rendered Marine plants his boots and fires a jubilant rifle salute into the sky for the supporter.",
    emoji: "🪖",
    callout: "LOCKED, LOADED, LEGENDARY",
    layout: "burst",
    entry: "rise",
    decorations: ["smoke", "speed-lines", "lightning"],
    accent: "#2563eb",
    accentAlt: "#fb923c",
    assetUrl: "/icons/sc2/units/marine.png",
    animationUrl: "/alerts/sc2-3d/marine-skyfire-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/marine-skyfire-3d.webp",
    adminOnly: true,
  },
  {
    id: "archon-merge-3d",
    label: "Archon Merge 3D",
    category: "StarCraft",
    description: "Two High Templar spiral through a psionic storm and resolve into one blazing 3D Archon around the alert.",
    emoji: "⚡",
    callout: "POWER OVERWHELMING",
    layout: "stage",
    entry: "zoom",
    decorations: ["lightning", "sparkles", "stars"],
    accent: "#8b5cf6",
    accentAlt: "#67e8f9",
    assetUrl: "/icons/sc2/units/archon.png",
    animationUrl: "/alerts/sc2-3d/archon-merge-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/archon-merge-3d.webp",
    adminOnly: true,
  },
  {
    id: "archon-backflip-3d",
    label: "Archon Backflip 3D",
    category: "StarCraft",
    description: "A fully rendered Archon defies several laws of physics, lands a backflip, and floods the card with psionic glow.",
    emoji: "🤸",
    callout: "PHYSICS OVERWHELMED",
    layout: "spotlight",
    entry: "spin",
    decorations: ["speed-lines", "lightning", "sparkles"],
    accent: "#a855f7",
    accentAlt: "#22d3ee",
    assetUrl: "/icons/sc2/units/archon.png",
    animationUrl: "/alerts/sc2-3d/archon-backflip-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/archon-backflip-3d.webp",
    adminOnly: true,
  },
  {
    id: "stalker-blink-3d",
    label: "Stalker Blink-In 3D",
    category: "StarCraft",
    description: "A 3D Stalker dissolves into blue shards, blinks across the alert, and reappears beside the supporter name.",
    emoji: "💫",
    callout: "BLINK COMPLETE",
    layout: "lower-third",
    entry: "glitch",
    decorations: ["pixels", "sparkles", "lightning"],
    accent: "#06b6d4",
    accentAlt: "#a78bfa",
    assetUrl: "/icons/sc2/units/stalker.png",
    animationUrl: "/alerts/sc2-3d/stalker-blink-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/stalker-blink-3d.webp",
    adminOnly: true,
  },
  {
    id: "carrier-interceptors-3d",
    label: "Carrier Interceptor Swarm 3D",
    category: "StarCraft",
    description: "A 3D Carrier glides overhead and launches a fan of interceptors to orbit the event like celebratory confetti.",
    emoji: "🛸",
    callout: "INTERCEPTORS RELEASED",
    layout: "stage",
    entry: "rise",
    decorations: ["speed-lines", "stars", "confetti"],
    accent: "#38bdf8",
    accentAlt: "#fbbf24",
    assetUrl: "/icons/sc2/units/carrier.png",
    animationUrl: "/alerts/sc2-3d/carrier-interceptors-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/carrier-interceptors-3d.webp",
    adminOnly: true,
  },
  {
    id: "zergling-zoomies-3d",
    label: "Zergling Zoomies 3D",
    category: "StarCraft",
    description: "A rendered Zergling gets the victory zoomies, races chaotic laps, then skids into the notification.",
    emoji: "🐾",
    callout: "ZOOMIES DETECTED",
    layout: "lower-third",
    entry: "slide-left",
    decorations: ["speed-lines", "smoke", "crowd"],
    accent: "#9333ea",
    accentAlt: "#a3e635",
    assetUrl: "/icons/sc2/units/zergling.png",
    animationUrl: "/alerts/sc2-3d/zergling-zoomies-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/zergling-zoomies-3d.webp",
    adminOnly: true,
  },
  {
    id: "baneling-bowling-3d",
    label: "Baneling Bowling 3D",
    category: "StarCraft",
    description: "A glossy 3D Baneling rolls down a neon lane and scatters holographic pins in a ridiculous perfect strike.",
    emoji: "🎳",
    callout: "BANELING STRIKE!",
    layout: "burst",
    entry: "spin",
    decorations: ["speed-lines", "glitch", "sparkles"],
    accent: "#65a30d",
    accentAlt: "#e879f9",
    assetUrl: "/icons/sc2/units/baneling.png",
    animationUrl: "/alerts/sc2-3d/baneling-bowling-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/baneling-bowling-3d.webp",
    adminOnly: true,
  },
  {
    id: "overlord-party-balloon-3d",
    label: "Overlord Party Balloon 3D",
    category: "StarCraft",
    description: "A cheerful rendered Overlord floats in like a biological party balloon, bobbing through streamers with the alert.",
    emoji: "🎈",
    callout: "PARTY SUPPLY ARRIVED",
    layout: "stage",
    entry: "drop",
    decorations: ["confetti", "crowd", "sparkles"],
    accent: "#7e22ce",
    accentAlt: "#fb7185",
    assetUrl: "/icons/sc2/units/overlord.png",
    animationUrl: "/alerts/sc2-3d/overlord-party-balloon-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/overlord-party-balloon-3d.webp",
    adminOnly: true,
  },
  {
    id: "battlecruiser-warp-in-3d",
    label: "Battlecruiser Warp-In 3D",
    category: "StarCraft",
    description: "A full 3D Battlecruiser tears through a blue warp tunnel, brakes over the card, and powers up its running lights.",
    emoji: "🚀",
    callout: "BATTLECRUISER OPERATIONAL",
    layout: "stage",
    entry: "zoom",
    decorations: ["spotlight", "smoke", "lightning"],
    accent: "#1d4ed8",
    accentAlt: "#f87171",
    assetUrl: "/icons/sc2/units/battlecruiser.png",
    animationUrl: "/alerts/sc2-3d/battlecruiser-warp-in-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/battlecruiser-warp-in-3d.webp",
    adminOnly: true,
  },
  {
    id: "mule-money-drop-3d",
    label: "MULE Money Drop 3D",
    category: "StarCraft",
    description: "A rendered MULE thunders down, opens its cargo clamps, and showers the alert with bonus-credit energy.",
    emoji: "💰",
    callout: "CALL DOWN: CASH",
    layout: "spotlight",
    entry: "drop",
    decorations: ["coins", "bills", "smoke"],
    accent: "#3b82f6",
    accentAlt: "#facc15",
    assetUrl: "/icons/sc2/units/mule.png",
    animationUrl: "/alerts/sc2-3d/mule-money-drop-3d.webm",
    animationPosterUrl: "/alerts/sc2-3d/mule-money-drop-3d.webp",
    adminOnly: true,
  },

  // Chaos
  {
    id: "glitch-gremlin",
    label: "Glitch Gremlin",
    category: "Chaos",
    description: "RGB splits and mischievous jitter turn the alert delightfully odd.",
    emoji: "👾",
    callout: "SIGNAL LOST (IN A FUN WAY)",
    layout: "card",
    entry: "glitch",
    decorations: ["glitch", "scanlines", "pixels"],
    accent: "#22d3ee",
    accentAlt: "#f43f5e",
  },
  {
    id: "emergency-broadcast",
    label: "Emergency Broadcast",
    category: "Chaos",
    description: "Warning bars and urgent type announce an impossible-to-miss event.",
    emoji: "🚨",
    callout: "THIS IS NOT A DRILL",
    layout: "stage",
    entry: "stamp",
    decorations: ["warning-stripes", "scanlines", "lightning"],
    accent: "#dc2626",
    accentAlt: "#facc15",
  },
  {
    id: "meteor-impact",
    label: "Meteor Impact",
    category: "Chaos",
    description: "A flaming code-drawn meteor lands behind the alert card.",
    emoji: "☄️",
    callout: "DIRECT HIT",
    layout: "burst",
    entry: "drop",
    decorations: ["meteors", "smoke", "speed-lines"],
    accent: "#ea580c",
    accentAlt: "#fef08a",
  },
  {
    id: "rubber-chicken",
    label: "Chaos Chicken",
    category: "Chaos",
    description: "A proudly ridiculous chicken ricochets through the notification.",
    emoji: "🐔",
    callout: "CHAOS CHICKEN ACTIVATED",
    layout: "spotlight",
    entry: "bounce",
    decorations: ["speed-lines", "confetti"],
    accent: "#f59e0b",
    accentAlt: "#ef4444",
  },
  {
    id: "cosmic-rift",
    label: "Cosmic Rift",
    category: "Chaos",
    description: "A violet portal opens and drops the supporter out of hyperspace.",
    emoji: "🌀",
    callout: "REALITY HAS LEFT CHAT",
    layout: "stage",
    entry: "spin",
    decorations: ["stars", "lightning", "sparkles"],
    accent: "#6d28d9",
    accentAlt: "#22d3ee",
  },
  {
    id: "maximum-vitality",
    label: "Maximum Vitality",
    category: "Chaos",
    description: "Every celebratory system fires together for controlled mayhem.",
    emoji: "🌪️",
    callout: "MAXIMUM VITALITY",
    layout: "stage",
    entry: "zoom",
    decorations: ["confetti", "bills", "frogs", "lightning", "stars"],
    accent: "#f43f5e",
    accentAlt: "#22d3ee",
  },
  // Meme — format-native, not image-native. Each reproduces the *shape* of a
  // viral format (Impact caption frame, sunglasses drop, crash dialog, VHS
  // tracking) using typography, CSS and emoji only. No third-party meme
  // photographs or film stills are referenced, so these ship to every account
  // with no licensing exposure and nothing to host.
  {
    id: "impact-caption",
    label: "Impact Caption",
    category: "Meme",
    description: "The classic white-on-black caption frame, stamped hard over a halftone print.",
    emoji: "🅰️",
    callout: "TOP TEXT ENERGY",
    layout: "card",
    entry: "stamp",
    decorations: ["halftone", "scanlines"],
    accent: "#e2e8f0",
    accentAlt: "#f43f5e",
  },
  {
    id: "deal-with-it",
    label: "Deal With It",
    category: "Meme",
    description: "Chunky pixel shades drop into place and refuse to elaborate further.",
    emoji: "😎",
    callout: "DEAL WITH IT",
    layout: "card",
    entry: "drop",
    decorations: ["pixels", "sparkles"],
    accent: "#0ea5e9",
    accentAlt: "#facc15",
  },
  {
    id: "bonk",
    label: "Bonk",
    category: "Meme",
    description: "A cartoon mallet swings down with a decisive, affectionate thud.",
    emoji: "🔨",
    callout: "BONK",
    layout: "burst",
    entry: "drop",
    decorations: ["speed-lines", "smoke", "halftone"],
    accent: "#f97316",
    accentAlt: "#fde68a",
  },
  {
    id: "not-stonks",
    label: "Not Stonks",
    category: "Meme",
    description: "The line goes catastrophically down, and we are all pretending it is fine.",
    emoji: "📉",
    callout: "NOT STONKS",
    layout: "card",
    entry: "drop",
    decorations: ["halftone", "smoke"],
    accent: "#ef4444",
    accentAlt: "#94a3b8",
  },
  {
    id: "big-brain",
    label: "Galaxy Brain",
    category: "Meme",
    description: "Expanding rings of cosmic enlightenment around a suspiciously large brain.",
    emoji: "🧠",
    callout: "GALAXY BRAIN",
    layout: "spotlight",
    entry: "zoom",
    decorations: ["stars", "sparkles", "spotlight"],
    accent: "#a855f7",
    accentAlt: "#22d3ee",
  },
  {
    id: "side-eye",
    label: "Side Eye",
    category: "Meme",
    description: "A single enormous eye slides over to judge the play you just made.",
    emoji: "👀",
    callout: "SUSPICIOUS",
    layout: "pill",
    entry: "slide-left",
    decorations: ["halftone"],
    accent: "#fbbf24",
    accentAlt: "#f8fafc",
  },
  {
    id: "vhs-rewind",
    label: "VHS Rewind",
    category: "Meme",
    description: "Tracking bars, a blinking record dot and the warm hum of analogue nostalgia.",
    emoji: "📼",
    callout: "BE KIND, REWIND",
    layout: "lower-third",
    entry: "glitch",
    decorations: ["scanlines", "glitch"],
    accent: "#64748b",
    accentAlt: "#f43f5e",
  },
  {
    id: "blue-screen",
    label: "Blue Screen",
    category: "Meme",
    description: "A mock system dialog reports that the requested skill could not be located.",
    emoji: "💻",
    callout: "SKILL NOT FOUND",
    layout: "card",
    entry: "glitch",
    decorations: ["pixels", "scanlines"],
    accent: "#2563eb",
    accentAlt: "#e0f2fe",
  },
  {
    id: "buffering",
    label: "Buffering",
    category: "Meme",
    description: "An eternal loading ring that promises the payoff is definitely coming.",
    emoji: "⏳",
    callout: "BUFFERING...",
    layout: "pill",
    entry: "pop",
    decorations: ["pixels"],
    accent: "#38bdf8",
    accentAlt: "#e2e8f0",
  },
  {
    id: "crickets",
    label: "Crickets",
    category: "Meme",
    description: "A tumbleweed rolls through the silence while one cricket does its best.",
    emoji: "🦗",
    callout: "...ANYWAY",
    layout: "lower-third",
    entry: "slide-up",
    decorations: ["smoke", "halftone"],
    accent: "#a3a3a3",
    accentAlt: "#d9f99d",
  },
  {
    id: "applause-sign",
    label: "Applause Sign",
    category: "Meme",
    description: "A studio APPLAUSE board lights up and the invisible audience obeys instantly.",
    emoji: "👏",
    callout: "APPLAUSE",
    layout: "card",
    entry: "bounce",
    decorations: ["crowd", "sparkles", "stars"],
    accent: "#f59e0b",
    accentAlt: "#fff7ed",
  },
  {
    id: "chat-is-this-real",
    label: "Chat, Is This Real",
    category: "Meme",
    description: "A speech bubble asks the question every viewer is already typing.",
    emoji: "💬",
    callout: "CHAT IS THIS REAL",
    layout: "card",
    entry: "rise",
    decorations: ["halftone", "sparkles"],
    accent: "#22c55e",
    accentAlt: "#fde047",
  },
] as const satisfies readonly AlertVisualPresetShape[];

export type AlertVisualPresetId =
  (typeof ALERT_VISUAL_PRESET_DEFINITIONS)[number]["id"];
export type AlertVisualPreset = Omit<AlertVisualPresetShape, "id"> & {
  readonly id: AlertVisualPresetId;
};
export const ALERT_VISUAL_PRESETS: readonly AlertVisualPreset[] =
  ALERT_VISUAL_PRESET_DEFINITIONS;

/**
 * Presets visible to a non-admin account. The SC2 3D renders are excluded:
 * their media is admin-gated, so offering them in the picker would surface
 * choices that render as static fallback art for the user who picked them.
 */
export const ALERT_VISUAL_PRESETS_PUBLIC: readonly AlertVisualPreset[] =
  ALERT_VISUAL_PRESETS.filter((preset) => !preset.adminOnly);

/** Presets an account may choose, given whether it holds admin. */
export function visiblePresetsFor(isAdmin: boolean): readonly AlertVisualPreset[] {
  return isAdmin ? ALERT_VISUAL_PRESETS : ALERT_VISUAL_PRESETS_PUBLIC;
}

/** True when the preset id is one of the admin-gated SC2 3D renders. */
export function isAdminOnlyPresetId(id: string): boolean {
  return ALERT_VISUAL_PRESETS.some(
    (preset) => preset.id === id && preset.adminOnly === true,
  );
}
export type AlertVisualSelection = AlertVisualPresetId | "shuffle";
export type AlertVisualMotion = "subtle" | "full" | "maximum";

export interface AlertConfig {
  eventVisuals: Record<ChatEventKind, AlertVisualSelection>;
  motion: AlertVisualMotion;
  durationSec: number;
  showHistory: boolean;
}

/** Compatibility name for callers that prefer the more explicit type. */
export type AlertVisualConfig = AlertConfig;

export const ALERT_VISUAL_PRESET_IDS: readonly AlertVisualPresetId[] =
  ALERT_VISUAL_PRESETS.map((preset) => preset.id);

const ALERT_VISUAL_PRESET_ID_SET: ReadonlySet<string> = new Set(
  ALERT_VISUAL_PRESET_IDS,
);

export const ALERT_VISUAL_PRESET_BY_ID = Object.fromEntries(
  ALERT_VISUAL_PRESETS.map((preset) => [preset.id, preset]),
) as Record<AlertVisualPresetId, AlertVisualPreset>;

export function isAlertVisualPresetId(
  value: unknown,
): value is AlertVisualPresetId {
  return typeof value === "string" && ALERT_VISUAL_PRESET_ID_SET.has(value);
}

export function isAlertVisualSelection(
  value: unknown,
): value is AlertVisualSelection {
  return value === "shuffle" || isAlertVisualPresetId(value);
}

export const DEFAULT_EVENT_VISUALS: Record<
  ChatEventKind,
  AlertVisualSelection
> = {
  sub: "classic",
  resub: "classic",
  giftsub: "classic",
  raid: "classic",
  member: "classic",
  superchat: "classic",
  gift: "classic",
  follow: "classic",
  cheer: "classic",
  share: "classic",
  reward: "classic",
};

/** Legacy-preserving defaults: today's card, timing and history stack. */
export const DEFAULT_ALERTS: AlertConfig = {
  eventVisuals: { ...DEFAULT_EVENT_VISUALS },
  motion: "full",
  durationSec: 8,
  showHistory: true,
};

/** Compatibility alias retained for explicit visual-config imports. */
export const DEFAULT_ALERT_VISUAL_CONFIG = DEFAULT_ALERTS;

/**
 * Shuffle pools are intentionally semantic rather than global. A follow leans
 * welcoming, a raid gets a large hype entrance, and money-bearing events favor
 * the cash family. This keeps shuffle surprising without becoming random noise.
 */
export const RECOMMENDED_EVENT_VISUALS: Record<
  ChatEventKind,
  readonly AlertVisualPresetId[]
> = {
  sub: [
    "classic",
    "clean-lower-third",
    "neon-card",
    "frog-hype",
    "heart-bloom",
    "level-up",
    "tiny-crown",
    "confetti-thanks",
    "protoss-warp-in",
    "zealot-dance-3d",
    "stalker-blink-3d",
    "impact-caption",
    "applause-sign",
  ],
  resub: [
    "classic",
    "laughing-man",
    "frog-sip",
    "gold-star",
    "victory-lap",
    "community-hug",
    "stonks",
    "chef-kiss",
    "archon-merge-3d",
    "archon-backflip-3d",
    "big-brain",
    "deal-with-it",
  ],
  giftsub: [
    "cash-pop",
    "money-rain",
    "jackpot",
    "gold-rush",
    "frog-party",
    "confetti-thanks",
    "airhorn",
    "maximum-vitality",
    "mule-money-drop",
    "overlord-delivery",
    "carrier-interceptors-3d",
    "mule-money-drop-3d",
    "overlord-party-balloon-3d",
    "applause-sign",
    "chat-is-this-real",
  ],
  raid: [
    "raid-boss",
    "boss-entrance",
    "arena-roar",
    "airhorn",
    "emergency-broadcast",
    "cosmic-rift",
    "frog-party",
    "maximum-vitality",
    "zergling-swarm",
    "battlecruiser-arrival",
    "marine-skyfire-3d",
    "zergling-zoomies-3d",
    "battlecruiser-warp-in-3d",
    "bonk",
    "impact-caption",
    "vhs-rewind",
  ],
  member: [
    "classic",
    "clean-lower-third",
    "cozy-welcome",
    "heart-bloom",
    "gold-star",
    "frog-business",
    "tiny-crown",
    "level-up",
    "protoss-warp-in",
    "archon-merge-3d",
    "zealot-dance-3d",
    "deal-with-it",
    "applause-sign",
  ],
  superchat: [
    "cash-pop",
    "money-rain",
    "stonks",
    "jackpot",
    "cash-register",
    "gold-rush",
    "chef-kiss",
    "neon-card",
    "mule-money-drop",
    "mule-money-drop-3d",
    "marine-skyfire-3d",
    "big-brain",
    "chat-is-this-real",
  ],
  gift: [
    "cash-pop",
    "money-rain",
    "jackpot",
    "gold-rush",
    "frog-party",
    "mind-blown",
    "confetti-thanks",
    "maximum-vitality",
    "overlord-delivery",
    "overlord-party-balloon-3d",
    "carrier-interceptors-3d",
    "mule-money-drop-3d",
    "applause-sign",
    "impact-caption",
  ],
  follow: [
    "classic",
    "minimal-pill",
    "clean-lower-third",
    "cozy-welcome",
    "heart-bloom",
    "frog-hype",
    "frog-sip",
    "gold-star",
    "protoss-warp-in",
    "stalker-blink-3d",
    "zealot-dance-3d",
    "chat-is-this-real",
    "side-eye",
    "buffering",
  ],
  cheer: [
    "airhorn",
    "arena-roar",
    "victory-lap",
    "comic-burst",
    "mind-blown",
    "frog-hype",
    "confetti-thanks",
    "maximum-vitality",
    "gg-fireworks",
    "zergling-swarm",
    "archon-backflip-3d",
    "marine-skyfire-3d",
    "baneling-bowling-3d",
    "deal-with-it",
    "big-brain",
  ],
  share: [
    "classic",
    "comic-burst",
    "cozy-welcome",
    "community-hug",
    "confetti-thanks",
    "victory-lap",
    "frog-party",
    "neon-card",
    "gg-fireworks",
    "carrier-interceptors-3d",
    "overlord-party-balloon-3d",
    "zealot-dance-3d",
    "vhs-rewind",
    "crickets",
    "side-eye",
  ],
  reward: [
    "pixel-panel",
    "plot-twist",
    "frog-oracle",
    "frog-bonk",
    "chef-kiss",
    "glitch-gremlin",
    "rubber-chicken",
    "overlord-delivery",
    "baneling-bowling-3d",
    "zergling-zoomies-3d",
    "stalker-blink-3d",
    "bonk",
    "not-stonks",
    "buffering",
    "crickets",
  ],
};

/** Compatibility alias; shuffle always draws from the recommended pools. */
export const ALERT_VISUAL_SHUFFLE_POOLS = RECOMMENDED_EVENT_VISUALS;

const ALERT_VISUAL_MOTIONS: readonly AlertVisualMotion[] = [
  "subtle",
  "full",
  "maximum",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration)) {
    return DEFAULT_ALERTS.durationSec;
  }
  return Math.min(15, Math.max(3, Math.round(duration)));
}

/** Strictly sanitize the untrusted preference blob into a complete config. */
export function sanitizeAlertConfig(raw: unknown): AlertConfig {
  const source = isRecord(raw) ? raw : {};
  const rawVisuals = isRecord(source.eventVisuals) ? source.eventVisuals : {};
  const eventVisuals = {} as Record<ChatEventKind, AlertVisualSelection>;

  for (const kind of CHAT_EVENT_KINDS) {
    const selection = rawVisuals[kind];
    eventVisuals[kind] = isAlertVisualSelection(selection)
      ? selection
      : DEFAULT_EVENT_VISUALS[kind];
  }

  return {
    eventVisuals,
    motion: ALERT_VISUAL_MOTIONS.includes(source.motion as AlertVisualMotion)
      ? (source.motion as AlertVisualMotion)
      : DEFAULT_ALERTS.motion,
    durationSec: clampDuration(source.durationSec),
    showHistory:
      typeof source.showHistory === "boolean"
        ? source.showHistory
        : DEFAULT_ALERTS.showHistory,
  };
}

/** Compatibility alias for the descriptive pre-integration name. */
export const sanitizeAlertVisualConfig = sanitizeAlertConfig;

/** Small deterministic FNV-1a hash; stable across browsers and sessions. */
function alertIdentityHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function resolveAlertVisualPresetId(
  selection: AlertVisualSelection,
  kind: ChatEventKind,
  eventIdentity: string,
): AlertVisualPresetId {
  if (selection !== "shuffle") return selection;
  const pool = RECOMMENDED_EVENT_VISUALS[kind];
  const index = alertIdentityHash(`${kind}\u0000${eventIdentity}`) % pool.length;
  return pool[index];
}

/** Resolve a saved choice to the complete renderer metadata record. */
export function resolveAlertVisualPreset(
  selection: AlertVisualSelection,
  kind: ChatEventKind,
  eventIdentity: string,
): AlertVisualPreset {
  return ALERT_VISUAL_PRESET_BY_ID[
    resolveAlertVisualPresetId(selection, kind, eventIdentity)
  ];
}
