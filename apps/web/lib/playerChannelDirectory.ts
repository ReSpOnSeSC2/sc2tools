import { safeChannelUrl } from "./playerChannelUrl";

export type PlayerChannelIdentity = {
  pulseCharacterId?: string;
  toonHandle?: string;
  /** Server-resolved directory match, including SC2Pulse aliases. */
  entryId?: string;
};

export type PlayerChannels = { twitch?: string | null; youtube?: string | null };

export type PlayerChannelEntry = {
  id: string;
  revision?: number;
  displayName: string;
  pulseCharacterIds: string[];
  toonHandles: string[];
  proId: string | null;
  channels: PlayerChannels;
  source: "admin" | "self" | "sc2pulse" | "curated";
  removed: boolean;
  updatedAt: string;
  editable: boolean;
  pending?: boolean;
  approvedChannels?: PlayerChannels;
};

export type MyPlayerChannelsResponse = {
  entries: PlayerChannelEntry[];
  identities: PlayerChannelIdentity[];
  canConnect: boolean;
};

export type PlayerChannelDirectoryResponse = {
  entries: PlayerChannelEntry[];
  total: number;
  page: number;
  limit: number;
};

export type PlayerChannelWrite = Pick<PlayerChannelEntry,
  "displayName" | "pulseCharacterIds" | "toonHandles" | "proId" | "channels"
> & { removed?: boolean; revision?: number };

export const CHANNEL_SOURCE_LABELS: Record<PlayerChannelEntry["source"], string> = {
  admin: "Admin",
  self: "Player connected",
  sc2pulse: "SC2Pulse",
  curated: "Curated",
};

export function identityLabel(identity: PlayerChannelIdentity): string {
  return identity.toonHandle || `Pulse ${identity.pulseCharacterId}`;
}

export function entryMatchesIdentity(entry: PlayerChannelEntry, identity: PlayerChannelIdentity): boolean {
  if (identity.entryId) return entry.id === identity.entryId;
  return Boolean(
    (identity.toonHandle && entry.toonHandles.includes(identity.toonHandle)) ||
    (identity.pulseCharacterId && entry.pulseCharacterIds.includes(identity.pulseCharacterId)),
  );
}

/** Restrict previews to channel pages on the expected platform. The API also validates on save. */
export function channelUrl(value: string | null | undefined, platform: "twitch" | "youtube"): string | null {
  const raw = value?.trim();
  if (!raw || raw.length > 300) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (platform === "youtube") {
      if (url.hostname === "m.youtube.com") url.hostname = "youtube.com";
      url.pathname = url.pathname.replace(/\/(?:featured|videos|shorts|streams|playlists|community|about)$/, "");
    } else {
      url.pathname = url.pathname.toLowerCase();
    }
    return safeChannelUrl(url.toString(), platform);
  } catch {
    return null;
  }
}

export function channelValidation(channels: { twitch: string; youtube: string }): string | null {
  if (channels.twitch.trim() && !channelUrl(channels.twitch, "twitch")) {
    return "Enter a Twitch channel URL, such as https://www.twitch.tv/yourname.";
  }
  if (channels.youtube.trim() && !channelUrl(channels.youtube, "youtube")) {
    return "Enter a YouTube channel URL, such as https://www.youtube.com/@yourname. Video and playlist links are not channel links.";
  }
  return null;
}

export function channelWrite(channels: { twitch: string; youtube: string }): PlayerChannels {
  return {
    twitch: channelUrl(channels.twitch, "twitch"),
    youtube: channelUrl(channels.youtube, "youtube"),
  };
}

export function directoryError(error: unknown): string {
  const value = error as { message?: string; details?: string[] } | undefined;
  return value?.details?.join(" ") || value?.message || "Please try again.";
}
