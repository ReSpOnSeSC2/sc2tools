"use client";
import { useState } from "react";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { PlayerCopyButton } from "@/components/public-profile/PlayerCopyButton";

export function PlayerPanelSettings({ slug, enabled }: { slug: string; enabled: boolean }) {
  const [style, setStyle] = useState("record"), [theme, setTheme] = useState("dark"), [height, setHeight] = useState("160");
  const root = `/players/${encodeURIComponent(slug)}`;
  const image = `${root}/panel.png?style=${style}&theme=${theme}&height=${height}`;
  return <section aria-label="Channel panel" className="space-y-3 rounded-xl border border-border p-4"><h3 className="font-semibold">Channel panel</h3>
    <p className="text-caption text-text-muted">Add a 320-pixel image panel to your channel. When your profile is off, the image is neutral.</p>
    <div className="grid gap-3 sm:grid-cols-3"><Field label="Panel style"><Select value={style} onChange={event => setStyle(event.target.value)}><option value="record">Record</option><option value="build">Featured build</option><option value="mmr">MMR history</option></Select></Field>
      <Field label="Panel theme"><Select value={theme} onChange={event => setTheme(event.target.value)}><option value="dark">Dark</option><option value="light">Light</option></Select></Field>
      <Field label="Panel size"><Select value={height} onChange={event => setHeight(event.target.value)}><option value="160">320 × 160</option><option value="100">320 × 100</option></Select></Field></div>
    {enabled ? <div className="flex flex-wrap gap-2"><PlayerCopyButton key={image} path={image} label="Copy image URL" /><PlayerCopyButton key={root} path={`${root}?utm_source=twitch_panel`} label="Copy panel link" /></div> : <p className="text-caption text-text-muted">Turn on your public profile and save to use a personal stats panel.</p>}
  </section>;
}
