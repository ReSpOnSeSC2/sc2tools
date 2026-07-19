// Bundled real-recording sound pack — 35 curated clips served from
// /sounds/multichat/*.mp3 (mono, 96 kbps, loudness-normalized at
// build time). Sourced exclusively from libraries that permit free
// commercial use: Mixkit (Mixkit Sound Effects Free License) and
// SoundBible (CC BY 3.0) — per-file provenance lives in
// public/sounds/multichat/CREDITS.md. These join the synthesized
// effects (soundEffects.ts) and the streamer's custom sounds in one
// unified picker namespace; ids must stay unique across all three
// (pinned by tests) and are whitelisted by the API sanitizer
// (services/multichatAppearance.js PACK_SOUND_IDS — keep in sync).

export type PackCategory = "memes" | "crowd" | "gags" | "hype" | "impact";

export interface PackSoundMeta {
  id: PackSoundId;
  label: string;
  category: PackCategory;
  durationMs: number;
}

export type PackSoundId =
  | "real-airhorn"
  | "cha-ching"
  | "cricket-chirp"
  | "falling-scream"
  | "cartoon-fart"
  | "game-over-trombone"
  | "goat-baa"
  | "metal-pipe"
  | "record-scratch"
  | "real-trombone"
  | "applause-big"
  | "applause-small"
  | "crowd-boo"
  | "crowd-laugh"
  | "party-cheer"
  | "boing-spring"
  | "cartoon-punch"
  | "clown-horn"
  | "evil-laugh"
  | "fail-drum"
  | "falling-whistle"
  | "magic-sparkle"
  | "police-whistle"
  | "duck-squeak"
  | "sad-party-horn"
  | "whip-crack"
  | "achievement-bell"
  | "arena-buzzer"
  | "real-drum-roll"
  | "fanfare-horns"
  | "wrong-buzzer"
  | "dramatic-sting"
  | "short-explosion"
  | "monster-roar"
  | "cinematic-thunder";

export const PACK_SOUNDS: readonly PackSoundMeta[] = [
  { id: "real-airhorn", label: "Airhorn (real)", category: "memes", durationMs: 2075 },
  { id: "cha-ching", label: "Cha-ching (cash register)", category: "memes", durationMs: 1600 },
  { id: "cricket-chirp", label: "Crickets", category: "memes", durationMs: 751 },
  { id: "falling-scream", label: "Falling scream", category: "memes", durationMs: 3019 },
  { id: "cartoon-fart", label: "Fart", category: "memes", durationMs: 829 },
  { id: "game-over-trombone", label: "Game over trombone", category: "memes", durationMs: 3544 },
  { id: "goat-baa", label: "Goat baa", category: "memes", durationMs: 974 },
  { id: "metal-pipe", label: "Metal pipe clang", category: "memes", durationMs: 786 },
  { id: "record-scratch", label: "Record scratch", category: "memes", durationMs: 356 },
  { id: "real-trombone", label: "Sad trombone (real)", category: "memes", durationMs: 2309 },
  { id: "applause-big", label: "Applause (big crowd)", category: "crowd", durationMs: 6008 },
  { id: "applause-small", label: "Applause (small group)", category: "crowd", durationMs: 3980 },
  { id: "crowd-boo", label: "Crowd boo", category: "crowd", durationMs: 5313 },
  { id: "crowd-laugh", label: "Crowd laugh", category: "crowd", durationMs: 3940 },
  { id: "party-cheer", label: "Party cheer", category: "crowd", durationMs: 4784 },
  { id: "boing-spring", label: "Boing (real)", category: "gags", durationMs: 517 },
  { id: "cartoon-punch", label: "Cartoon punch", category: "gags", durationMs: 227 },
  { id: "clown-horn", label: "Clown horn", category: "gags", durationMs: 845 },
  { id: "evil-laugh", label: "Evil laugh", category: "gags", durationMs: 1658 },
  { id: "fail-drum", label: "Fail drum", category: "gags", durationMs: 2258 },
  { id: "falling-whistle", label: "Falling whistle", category: "gags", durationMs: 2347 },
  { id: "magic-sparkle", label: "Magic sparkle", category: "gags", durationMs: 741 },
  { id: "police-whistle", label: "Referee whistle", category: "gags", durationMs: 1000 },
  { id: "duck-squeak", label: "Rubber duck", category: "gags", durationMs: 545 },
  { id: "sad-party-horn", label: "Sad party horn", category: "gags", durationMs: 1274 },
  { id: "whip-crack", label: "Whip crack", category: "gags", durationMs: 171 },
  { id: "achievement-bell", label: "Achievement bell", category: "hype", durationMs: 946 },
  { id: "arena-buzzer", label: "Arena buzzer", category: "hype", durationMs: 2040 },
  { id: "real-drum-roll", label: "Drum roll (real)", category: "hype", durationMs: 4664 },
  { id: "fanfare-horns", label: "Victory fanfare (horns)", category: "hype", durationMs: 2358 },
  { id: "wrong-buzzer", label: "Wrong-answer buzzer", category: "hype", durationMs: 2160 },
  { id: "dramatic-sting", label: "Dramatic sting (dun dun!)", category: "impact", durationMs: 2675 },
  { id: "short-explosion", label: "Explosion (real)", category: "impact", durationMs: 509 },
  { id: "monster-roar", label: "Monster roar", category: "impact", durationMs: 3032 },
  { id: "cinematic-thunder", label: "Thunder (real)", category: "impact", durationMs: 3731 },
] as const;

export const PACK_SOUND_IDS: readonly PackSoundId[] = PACK_SOUNDS.map(
  (s) => s.id,
);

export const PACK_CATEGORY_LABEL: Record<PackCategory, string> = {
  memes: "Meme classics",
  crowd: "Crowd reactions",
  gags: "Cartoon & gags",
  hype: "Hype & game show",
  impact: "Impacts & drama",
};

export const PACK_CATEGORIES: readonly PackCategory[] = [
  "memes",
  "crowd",
  "gags",
  "hype",
  "impact",
];

export function isPackSoundId(value: unknown): value is PackSoundId {
  return PACK_SOUND_IDS.includes(value as PackSoundId);
}

/** Same-origin URL of a bundled pack sound. */
export function packSoundUrl(id: PackSoundId): string {
  return `/sounds/multichat/${id}.mp3`;
}
