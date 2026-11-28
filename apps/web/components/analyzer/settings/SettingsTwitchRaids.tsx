"use client";

import { useId } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { Toggle } from "@/components/ui/Toggle";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import type { RaidSettingsView } from "@/lib/twitchRaids";
import { useTwitchRaidSettings } from "./twitchRaidSettingsModel";

/** What the streamer can do next, in the order the steps happen. */
function permissionText(status: RaidSettingsView): string {
  if (!status.serverEnabled) return "Raids are paused by the server owner. Nothing here can start one until they are turned on.";
  if (!status.connected) return "Twitch is not connected. Connect raids to link your channel and ask for the raid permission in one step.";
  if (!status.permission) return "Twitch is connected, but raids have not been allowed. Connect raids to approve the permission.";
  return "Twitch has allowed raids from SC2 Tools.";
}

export function SettingsTwitchRaids() {
  const { isLoaded, userId } = useAuth();
  if (!isLoaded) return <SkeletonRegion label="Loading account"><SkeletonBar className="h-24 w-full" /></SkeletonRegion>;
  return userId ? <RaidEditor key={userId} owner={userId} /> : <p className="text-caption">Sign in to manage raids.</p>;
}

function RaidEditor({ owner }: { owner: string }) {
  const id = useId();
  const { status, busy, error, message, refresh, setEnabled, connect } = useTwitchRaidSettings(owner);
  const canSwitchOn = status?.reason === null;
  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-surface p-3">
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-body font-semibold">Twitch raids</h3>
      <p className="text-caption text-text-muted">When you pick Stream ending in the Stream Dock, it lists live StarCraft II channels, smallest first, and raids one in a confirmed click. Raids start off.</p>
    </div>
    {status ? <p role="status" className="rounded-md border border-border bg-bg-elevated px-3 py-2 text-caption">{permissionText(status)}</p>
      : busy ? <SkeletonRegion label="Checking raid status"><SkeletonBar className="h-10 w-full" /></SkeletonRegion> : null}
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" className="min-h-11" disabled={busy || !status?.serverEnabled} onClick={() => void connect()}>
        {status?.permission ? "Reconnect raids" : "Connect raids"}
      </Button>
      <Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => void refresh()}>Refresh status</Button>
    </div>
    <label htmlFor={`${id}-switch`} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3 text-caption">
      <span className="min-w-0">Allow raids from the Stream Dock</span>
      <Toggle id={`${id}-switch`} checked={status?.enabled === true} disabled={busy || !status || !status.enabled && !canSwitchOn} onChange={enabled => void setEnabled(enabled)} />
    </label>
    <p className="text-caption text-text-muted">The switch saves as soon as you change it. While it is on, raids you receive are kept in the Dock&apos;s raid history. Twitch allows 10 raid requests every 10 minutes.</p>
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
    {message ? <p role="status" className="text-caption text-success">{message}</p> : null}
    <LazyHelpLink slug="raid-finder" className="inline-flex min-h-11 items-center underline">Raid finder help</LazyHelpLink>
  </section>;
}
