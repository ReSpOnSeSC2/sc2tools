"use client";

import Link from "next/link";
import { SettingsMultiChat } from "./SettingsMultiChat";
import { OverlayBotSettings, OverlayDockSetup } from "./OverlayDockSetup";
import { useSettingsStreamingToken } from "./SettingsStreamingTokenOwner";

const CHAT_SECTIONS = [
  ["platforms", "Platforms"], ["appearance", "Appearance"], ["alerts", "Alerts"],
  ["tts", "Text to speech"], ["translation", "Translation"], ["commands", "Commands"],
  ["dock", "Stream Dock"], ["bot", "Bot"],
] as const;

/** The actual chat forms live here once, never hidden inside Overlay. */
export function SettingsChat({ origin }: { origin?: string }) {
  const { token, isCurrent } = useSettingsStreamingToken();
  return <div className="space-y-6">
    <header><h2 className="text-body-lg font-semibold text-text">Chat & alerts</h2>
      <p className="mt-1 text-body text-text-muted">Configure platforms, chat, alerts and your bot. Add the chat Browser Source from <Link href="/settings?tab=overlay&section=widgets&widget=multichat" className="text-accent underline">Overlay → Widgets</Link>.</p></header>
    <nav aria-label="Chat settings sections" className="flex max-w-full flex-wrap gap-2">{CHAT_SECTIONS.map(([id, label]) => <Link key={id} href={`/settings?tab=chat#${id}`} scroll={false} className="inline-flex min-h-11 items-center rounded-full border border-border px-3 text-caption text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}</Link>)}</nav>
    <SettingsMultiChat token={token.token} />
    <section id="dock" className="scroll-mt-28"><OverlayDockSetup token={token.token} origin={origin} /></section>
    <section id="bot" className="scroll-mt-28"><OverlayBotSettings isCurrent={isCurrent} /></section>
  </div>;
}
