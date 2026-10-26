import type { PublicPlayerProfile, PublicPlayerSettings } from "../types";
export const PUBLIC_PLAYER: PublicPlayerProfile = {
  handle: "frontier-0123456789", displayName: "Frontier", mainRace: "Protoss", joinedAt: null,
  totals: { games: 20, wins: 12, losses: 8, winRate: 0.6 },
  matchups: [{ matchup: "vs T", games: 20, wins: 12, losses: 8, winRate: 0.6 }], signatureBuilds: [], featuredBuild: null, publishedBuildCount: 0,
  sections: { showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false }, replayArchive: null,
};
export const PLAYER_SETTINGS: PublicPlayerSettings = {
  publicDisplayName: PUBLIC_PLAYER.displayName,
  enabled: false, legacyPublic: false, slug: PUBLIC_PLAYER.handle, updatedAt: null, renameAvailableAt: null, replaySharingEnabled: false, revision: 0,
  showReplays: false, showChannels: false, showRecentForm: false, showMmrHistory: false, showSeasons: false, showMaps: false,
};
export const playerEnvelope = (profile: PublicPlayerProfile = PUBLIC_PLAYER) => ({ profile, handle: profile.handle, displayName: profile.displayName, archiveOnly: false });
