"use client";

import { useEffect, useState } from "react";
import type { StudioState } from "@/lib/multichat/useStudioState";
import type { MultichatConfig } from "@/lib/multichat/types";
import type { DockSectionId } from "@/lib/dockLayout";
import { STUDIO_SCENE_LABELS } from "@/lib/multichat/sceneModes";
import { formatCountdown } from "@/components/overlay/widgets/StreamSceneWidget";

export type DockSummary = { summary: string; active?: boolean; loading?: boolean };
export function useDockSummaries(studio: StudioState, ready: boolean, platforms: MultichatConfig | null,
  platformsReady: boolean, votes: number, clips: number, clipsReady: boolean): Record<DockSectionId, DockSummary> {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!studio.scene && !studio.timer) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [studio.scene, studio.timer]);
  const count = platforms ? [platforms.twitch?.enabled && platforms.twitch.channel,
    platforms.kick?.enabled && platforms.kick.chatroomId, platforms.youtube?.enabled && platforms.youtube.channel,
    platforms.tiktok?.enabled && platforms.tiktok.username].filter(Boolean).length : 0;
  const scene = studio.scene;
  const remaining = scene?.countdownEndsAt ? Math.max(0, scene.countdownEndsAt - now) : null;
  const timerLeft = studio.timer ? Math.max(0, studio.timer.endsAt - now) : 0;
  return {
    "dock-scout": { summary: "Live opponent brief" },
    "dock-chat": { summary: `${count} ${count === 1 ? "platform" : "platforms"}`, loading: !platformsReady || !ready },
    "dock-highlight": { summary: studio.highlight ? "Pinned" : "Nothing pinned", active: !!studio.highlight, loading: !ready },
    "dock-scenes": { summary: scene ? `${STUDIO_SCENE_LABELS[scene.mode]}${remaining !== null ? ` · ${formatCountdown(remaining)}` : ""}` : "Live", active: !!scene, loading: !ready },
    "dock-build-profile": { summary: studio.buildProfile.visible ? "Shown" : "Hidden", active: studio.buildProfile.visible, loading: !ready },
    "dock-timer": { summary: studio.timer ? timerLeft > 0 ? `${formatCountdown(timerLeft)} left` : "Time!" : "No countdown", active: timerLeft > 0, loading: !ready },
    "dock-poll": { summary: studio.poll ? `${studio.poll.status === "open" ? "Open" : "Closed"} · ${votes} votes` : "No poll", active: studio.poll?.status === "open", loading: !ready },
    "dock-goals": { summary: `${studio.goals.length} active`, active: studio.goals.length > 0, loading: !ready },
    "dock-clips": { summary: `${clips} ${clips === 1 ? "moment" : "moments"}`, loading: !clipsReady },
    "dock-actions": { summary: "Recap & setup", loading: !ready },
  };
}
