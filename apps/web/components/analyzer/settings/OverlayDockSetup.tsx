"use client";
import { Card } from "@/components/ui/Card";
import { useApi } from "@/lib/clientApi";
import type { MultichatConfig } from "@/lib/multichat/types";
import { UrlRow } from "./OverlayUrlRow";
import { ChatBotCard } from "./ChatBotCard";
export function OverlayDockSetup({ token, origin }: { token: string; origin?: string }) {
  return <Card title="Add Stream Dock to OBS"><div id="stream-dock" className="scroll-mt-28 space-y-3"><p className="text-caption text-text-muted">In OBS, open Docks → Custom Browser Docks. Name it SC2 Tools, paste this private Dock URL and press Apply. Dock controls can show real content on stream; use widget Preview when checking a sample.</p><UrlRow url={`${origin ?? ""}/dock/${token}`} compact /></div></Card>;
}
export function OverlayBotSettings({ isCurrent }: { isCurrent?: () => boolean } = {}) {
  const { data } = useApi<MultichatConfig>("/v1/me/preferences/multichat");
  return <Card title="Chat bot"><ChatBotCard twitchChannel={data?.twitch?.channel ?? ""} isCurrent={isCurrent} /></Card>;
}
