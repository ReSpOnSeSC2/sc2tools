"use client";

import { Twitch as TwitchIcon, Youtube as YouTubeIcon } from "lucide-react";
import { formatOffset, vodLinkAt } from "@/lib/vodLinks";

export type GameStreamPlatform = "twitch" | "youtube";
export type GameStreamPerspective = "me" | "opponent";

export type GameStreamLink = {
  platform: GameStreamPlatform;
  perspective: GameStreamPerspective;
  playerName?: string | null;
  url: string;
  offsetSec: number;
  videoId?: string;
};

export type GameVodLinksResponse = {
  configuredPlatforms: GameStreamPlatform[];
  linksByGameId: Record<string, GameStreamLink[]>;
};

const PLATFORM_LABEL: Record<GameStreamPlatform, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
};

const PLATFORM_ICON = {
  twitch: TwitchIcon,
  youtube: YouTubeIcon,
} satisfies Record<GameStreamPlatform, typeof TwitchIcon>;

/** Timestamped Twitch/YouTube VOD chips for one replay. */
export function GameStreamLinks({
  links,
  compact = false,
  className = "",
}: {
  links?: readonly GameStreamLink[] | null;
  compact?: boolean;
  className?: string;
}) {
  const safeLinks = (links ?? []).flatMap((link, index) => {
    const href = safeTimestampedHref(link);
    return href
      ? [{ ...link, href, key: `${link.platform}:${link.url}:${index}` }]
      : [];
  });

  if (safeLinks.length === 0) return null;

  return (
    <div
      className={["inline-flex flex-wrap items-center gap-1.5", className]
        .filter(Boolean)
        .join(" ")}
      aria-label="Game streams"
    >
      {(["me", "opponent"] as const).map((perspective) => {
        const group = safeLinks.filter(
          (link) => link.perspective === perspective,
        );
        if (group.length === 0) return null;
        const perspectiveLabel = perspective === "me" ? "You" : "Opponent";
        const groupPlayer = group
          .map((link) => link.playerName?.trim())
          .find(Boolean);
        return (
          <div
            key={perspective}
            role="group"
            aria-label={`${perspectiveLabel} POV streams${
              groupPlayer ? ` - ${groupPlayer}` : ""
            }`}
            className="inline-flex overflow-hidden rounded-md border border-border-strong bg-bg-elevated/75 shadow-sm"
          >
            <span className="inline-flex items-center border-r border-border-strong px-1.5 text-[10px] font-bold uppercase tracking-wide text-text-muted">
              {perspective === "me" ? "You" : "Opp"}
            </span>
            {group.map((link, index) => {
              const platform = PLATFORM_LABEL[link.platform];
              const PlatformIcon = PLATFORM_ICON[link.platform];
              const offset = formatOffset(link.offsetSec * 1000);
              const player = link.playerName?.trim() ?? "";
              const label = `Watch ${perspectiveLabel} POV on ${platform} at ${offset}${player ? ` - ${player}` : ""}`;
              return (
                <a
                  key={link.key}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  aria-label={label}
                  title={label}
                  data-perspective={perspective}
                  className={[
                    "inline-flex items-center justify-center transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    link.platform === "twitch"
                      ? "text-[#9146ff] hover:bg-[#9146ff]/15 hover:text-[#a970ff] focus-visible:ring-[#9146ff]"
                      : "text-text hover:bg-bg-subtle hover:text-accent focus-visible:ring-accent",
                    index > 0 ? "border-l border-border-strong" : "",
                    compact ? "h-7 w-7" : "h-9 w-9",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <PlatformIcon
                    className={compact ? "h-3.5 w-3.5" : "h-4 w-4"}
                    aria-hidden
                  />
                </a>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function safeTimestampedHref(link: GameStreamLink): string | null {
  if (
    (link.platform !== "twitch" && link.platform !== "youtube")
    || (link.perspective !== "me" && link.perspective !== "opponent")
    || typeof link.url !== "string"
    || (link.playerName != null && typeof link.playerName !== "string")
    || !Number.isFinite(link.offsetSec)
  ) {
    return null;
  }

  try {
    const url = new URL(link.url);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (link.platform === "twitch" && host !== "twitch.tv") return null;
    if (
      link.platform === "youtube"
      && host !== "youtube.com"
      && host !== "youtu.be"
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return vodLinkAt(link.url, Math.max(0, link.offsetSec) * 1000);
}
