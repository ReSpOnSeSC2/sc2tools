"use client";

import Link from "next/link";
import { SettingsMultiChat } from "./SettingsMultiChat";
import { OverlayBotSettings, OverlayDockSetup } from "./OverlayDockSetup";
import { useSettingsStreamingToken } from "./SettingsStreamingTokenOwner";

/** The actual chat forms live here once, never hidden inside Overlay. */
export function SettingsChat({ origin }: { origin?: string }) {
  const { token, isCurrent } = useSettingsStreamingToken();
  return <div className="space-y-6">
    <header><h2 className="text-body-lg font-semibold text-text">Chat & alerts</h2>
      <p className="mt-1 text-body text-text-muted">Configure platforms, chat, alerts and your bot. Add the chat Browser Source from <Link href="/settings?tab=overlay&section=widgets&widget=multichat" className="text-accent underline">Overlay → Widgets</Link>.</p></header>
    <SettingsMultiChat token={token.token} />
    <section id="dock" className="scroll-mt-28"><OverlayDockSetup token={token.token} origin={origin} /></section>
    <section id="bot" className="scroll-mt-28"><OverlayBotSettings isCurrent={isCurrent} /></section>
  </div>;
}
