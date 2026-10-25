"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { WIDGET_GUIDES, WIDGET_GROUPS } from "@/lib/streamStudioLearn";
import { appendOverlayThemeToUrl, type OverlayTheme } from "@/lib/overlayTheme";
import { appendGhostToUrl, type GhostBuildConfig } from "@/lib/ghostBuild";
import { appendGhostVoiceToUrl, GHOST_VOICE_STORAGE_KEY } from "@/lib/ghostVoice";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { UrlRow } from "./OverlayUrlRow";
import { WIDGETS } from "./overlayWidgetMeta";
import type { OverlayToken } from "./OverlayTokenHeader";
import { useObsAddSource } from "./useObsAddSource";
import { WidgetPreviewButton } from "./WidgetPreviewButton";

/** OBS's documented URL-drop contract. Query parameters stay before Ghost's fragment. */
export function obsWidgetDropUrl(url: string, name: string, width: number, height: number): string {
  const parsed = new URL(url, "https://sc2tools.invalid");
  parsed.searchParams.set("layer-name", `SC2 Tools — ${name}`);
  parsed.searchParams.set("layer-width", String(width)); parsed.searchParams.set("layer-height", String(height));
  return url.startsWith("/") ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}

export function WidgetList({ token, origin, theme, ghostConfig, busy, onToggleWidget, onTestWidget, testingWidget }: {
  token: OverlayToken; origin?: string; theme: OverlayTheme; ghostConfig: GhostBuildConfig; busy: boolean;
  onToggleWidget: (widget: string, enabled: boolean) => void; onTestWidget: (widget: string) => void; testingWidget: string | null;
}) {
  const [search, setSearch] = useState(""), [enabledOnly, setEnabledOnly] = useState(false), [ghostVoice, setGhostVoice] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null), host = useRef<HTMLDivElement>(null);
  const requested = useSearchParams().get("widget");
  const obs = useObsAddSource();
  const enabled = useMemo(() => new Set(token.enabledWidgets ?? WIDGETS.map(widget => widget.id)), [token.enabledWidgets]);
  useEffect(() => { try { setGhostVoice(localStorage.getItem(GHOST_VOICE_STORAGE_KEY) === "1"); } catch { /* Optional device preference. */ } }, []);
  useEffect(() => {
    if (!requested || !WIDGETS.some(widget => widget.id === requested)) return;
    setSearch(""); setEnabledOnly(false); setHighlight(requested);
    const frame = requestAnimationFrame(() => {
      const card = host.current?.querySelector<HTMLElement>(`[data-widget-id="${requested}"]`);
      card?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      card?.querySelector<HTMLButtonElement>("[data-widget-copy]")?.focus({ preventScroll: true });
    });
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [requested, token.token]);
  const visible = WIDGET_GUIDES.filter(guide => {
    const metadata = WIDGETS.find(widget => widget.id === guide.id);
    return metadata && (!enabledOnly || metadata.urlArmed || enabled.has(guide.id)) && `${guide.name} ${guide.summary}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  return <div ref={host} className="min-w-0 space-y-6 p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-3"><label className="min-w-0 flex-1 text-caption text-text-muted">Find a widget<input type="search" value={search} onChange={event => setSearch(event.target.value)} className="mt-1 block min-h-11 w-full rounded border border-border bg-bg-surface px-3 text-text" /></label><label className="flex min-h-11 items-center gap-2 text-caption text-text"><input type="checkbox" checked={enabledOnly} onChange={event => setEnabledOnly(event.target.checked)} />Enabled only</label></div>
    <p className="text-caption text-text-muted">Copy works with OBS and Streamlabs. Drag into OBS supplies a source name and recommended size. Adjust the source after testing if your theme or content needs more room.</p>
    <div className="space-y-2 text-caption text-text-muted">
      <p>Add to OBS asks your desktop agent to add a recommended-size source to its current program scene. You must confirm there; it can appear on your live stream.</p>
      {obs.devices.length > 1 ? <label className="block">Desktop agent<select className="ml-2 min-h-11 max-w-full rounded border border-border bg-bg-surface px-2 text-text" value={obs.deviceId} disabled={!!obs.busy} onChange={event => obs.setDeviceId(event.target.value)}><option value="">Choose an agent</option>{obs.devices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}</select></label> : null}
      {obs.reason ? <p>{obs.reason} <button type="button" className="min-h-11 px-2 text-accent underline" disabled={!!obs.busy} onClick={obs.retry}>Check again</button></p> : null}
      {obs.message ? <p role="status" aria-live="polite" className="text-text">{obs.message}</p> : null}
    </div>
    {WIDGET_GROUPS.map(group => {
      const guides = visible.filter(guide => guide.group === group.id);
      return guides.length ? <section key={group.id} aria-labelledby={`widget-group-${group.id}`} className="space-y-3"><h3 id={`widget-group-${group.id}`} className="text-body-lg font-semibold">{group.name}</h3><p className="text-caption text-text-muted">{group.description}</p><div className="grid min-w-0 gap-4 xl:grid-cols-2">{guides.map(guide => {
        const metadata = WIDGETS.find(widget => widget.id === guide.id)!, isOn = !!metadata.urlArmed || enabled.has(guide.id), isTesting = testingWidget === guide.id;
        const themedUrl = appendOverlayThemeToUrl(`${origin ?? ""}/overlay/${token.token}/widget/${guide.id}`, theme);
        const url = guide.id === "ghost-build" ? appendGhostToUrl(appendGhostVoiceToUrl(themedUrl, ghostVoice), ghostConfig) : themedUrl;
        const { width, height } = guide.recommendedSize, dropUrl = obsWidgetDropUrl(url, guide.name, width, height);
        return <article key={guide.id} data-widget-id={guide.id} className={`min-w-0 rounded-xl border bg-bg-surface p-3 ${highlight === guide.id ? "border-accent ring-2 ring-accent" : "border-border"}`}>
          <Image src={`/images/widget-examples/${guide.id}.webp`} alt={`${guide.name} illustrative example`} width={1400} height={900} sizes="(min-width:1280px) 40vw, 85vw" className="mb-3 aspect-[14/9] w-full rounded-lg object-cover" />
          <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="text-body font-semibold">{guide.name}</h4>{metadata.urlArmed ? <Badge variant="cyan">URL enabled</Badge> : <Toggle checked={isOn} disabled={busy} onChange={on => onToggleWidget(guide.id, on)} label={`Enable ${guide.name}`} />}</div>
          <p className="mt-2 break-words text-caption text-text-muted">{guide.summary}</p><p className="my-2 font-mono text-caption tabular-nums">Recommended {width} × {height}</p>
          {guide.id === "ghost-build" ? <div className="my-3 space-y-2 text-caption text-text-muted"><p>{Object.keys(ghostConfig.slots).length}/9 matchups assigned. Choose builds in Look before copying.</p><label className="flex items-center gap-2"><input type="checkbox" checked={ghostVoice} onChange={event => { const on = event.target.checked; setGhostVoice(on); try { localStorage.setItem(GHOST_VOICE_STORAGE_KEY, on ? "1" : "0"); } catch { /* Still works this visit. */ } }} />Voice coach (copy again after changing)</label></div> : null}
          <UrlRow url={url} compact onTest={metadata.noTest ? undefined : () => onTestWidget(guide.id)} testing={isTesting} testDisabled={(testingWidget !== null && !isTesting) || !isOn} testTitle={isTesting ? "Stop this test" : isOn ? "Preview this widget, with confirmation before a live test" : "Enable this widget first"} />
          <div className="mt-3 flex flex-wrap gap-3 text-caption"><a href={dropUrl} draggable onClick={event => event.preventDefault()} onDragStart={event => { event.dataTransfer.setData("text/uri-list", dropUrl); event.dataTransfer.setData("text/plain", dropUrl); }} className="inline-flex min-h-11 items-center rounded border border-border px-3 font-semibold text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Drag into OBS</a><button type="button" disabled={!!obs.reason || !isOn} title={isOn ? obs.reason || "Confirm in the desktop agent before adding" : "Enable this widget first"} onClick={() => void obs.add(guide.id)} className="min-h-11 rounded border border-border px-3 font-semibold text-accent disabled:cursor-not-allowed disabled:opacity-50">{obs.busy === guide.id ? "Waiting for desktop…" : "Add to OBS"}</button><Link href={`/stream-studio/learn?widget=${encodeURIComponent(guide.id)}#widget-library`} target="_blank" rel="noopener noreferrer" aria-label={`${guide.name}: how it works (opens in a new tab)`} className="inline-flex min-h-11 items-center text-accent underline">How it works</Link><WidgetPreviewButton widget={guide.id} name={guide.name} /></div>
        </article>;
      })}</div></section> : null;
    })}
    {!visible.length ? <p role="status" className="text-caption text-text-muted">No widgets match. Clear the search or turn off Enabled only.</p> : null}
  </div>;
}
