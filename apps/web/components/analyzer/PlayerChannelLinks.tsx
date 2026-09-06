"use client";

import { Twitch, Youtube } from "lucide-react";
import { safeChannelUrl } from "@/lib/playerChannelUrl";
export { safeChannelUrl } from "@/lib/playerChannelUrl";

export type PlayerChannels = { twitch?: string | null; youtube?: string | null };

/** Channel links are distinct from recordings: never imply this game was streamed. */
export function PlayerChannelLinks({ channels, playerName, compact = false }: {
  channels?: PlayerChannels | null;
  playerName?: string | null;
  compact?: boolean;
}) {
  const links = (["twitch", "youtube"] as const).flatMap((platform) => {
    const href = safeChannelUrl(channels?.[platform], platform);
    return href ? [{ platform, href }] : [];
  });
  if (!links.length) return null;
  const name = playerName?.trim() || "Player";
  return (
    <span className="inline-flex flex-wrap items-center gap-1" role="group" aria-label={`${name} channels`}>
      {links.map(({ platform, href }) => {
        const Icon = platform === "twitch" ? Twitch : Youtube;
        const label = platform === "twitch" ? "Twitch" : "YouTube";
        return (
          <a key={platform} href={href} target="_blank" rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            aria-label={`Visit ${name}'s ${label} channel`} title={`${name} · ${label} channel`}
            className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-bg-elevated px-2 text-caption font-medium transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${platform === "twitch" ? "text-[#9146ff]" : "text-[#e52222]"}`}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {!compact ? <span>{label}</span> : null}
          </a>
        );
      })}
    </span>
  );
}
