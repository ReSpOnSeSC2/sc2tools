"use client";

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { WidgetRenderer } from "@/components/OverlayWidgetClient";
import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
import { localPreviewRandomizer } from "@/components/overlay/OverlayLocalPreviewFrame";
import { ALL_WIDGETS, type WidgetId } from "@/components/overlay/widgetLifecycle";
import { WIDGET_GUIDES, WIDGET_GROUPS } from "@/lib/streamStudioLearn";
import { OVERLAY_THEME_PRESETS, themeToCssVars, type OverlayTheme } from "@/lib/overlayTheme";
import { OVERLAY_SAMPLE_SCENARIOS, overlaySample, sampleLiveGame, sampleStudio } from "@/lib/overlaySamples";
import { encodeGhostBuildConfig, GHOST_BUILD_CONFIG_VERSION, GHOST_BUILD_VERSION } from "@/lib/ghostBuild";
import { CHECKERBOARD, PREVIEW_CSS } from "@/lib/overlayPreviewStyles";
import { Button } from "@/components/ui/Button";

const ghost = encodeGhostBuildConfig({ v: GHOST_BUILD_CONFIG_VERSION, slots: { PvZ: { v: GHOST_BUILD_VERSION, name: "Sample Stargate plan", steps: [
  { t: 14, supply: 14, name: "Pylon" }, { t: 45, supply: 16, name: "Gateway" }, { t: 102, supply: 20, name: "CyberneticsCore" }, { t: 165, supply: 28, name: "Stargate" }, { t: 210, supply: 34, name: "Oracle" },
] } } });

/** Pure local widget host: no real token or socket is ever created. */
export function PlaygroundWidget({ widget, scenario, revision = 0 }: { widget: WidgetId; scenario: string; revision?: number }) {
  const snapshot = useMemo(() => ({ scenario, revision, atMs: Date.now() }), [scenario, revision]);
  const now = snapshot.atMs;
  const live = useMemo(() => overlaySample(widget, scenario, now), [widget, scenario, now]);
  const liveGame = useMemo(() => sampleLiveGame(scenario, now), [scenario, now]);
  const studio = useMemo(() => sampleStudio(now), [now]);
  const randomizer = useMemo(localPreviewRandomizer, []);
  return <OverlayPreviewContext.Provider value={true}><WidgetRenderer widget={widget} token="local-playground" live={live} liveGame={liveGame}
    session={live.session ?? null} randomizer={randomizer} randomizerIntent={null} onRandomizerSpin={() => undefined} visible ghostParam={ghost}
    studioEvent={studio} engagementEvent={null} voicePrefs={null} /></OverlayPreviewContext.Provider>;
}

/** Fit the actual card, including changing demo content, inside its checkerboard. */
function SampleStage({ widget, scenario, theme, revision, actual = false, small = false }: {
  widget: WidgetId; scenario: string; theme: OverlayTheme; revision: number; actual?: boolean; small?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), currentScale = useRef(1);
  const guide = WIDGET_GUIDES.find(item => item.id === widget)!;
  const [fit, setFit] = useState(1), [dimensions, setDimensions] = useState({ ...guide.recommendedSize, x: 0, y: 0 });
  useLayoutEffect(() => {
    const host = stage.current, sample = card.current; if (!host || !sample) return;
    const measure = () => {
      // Self-driven sources use a transparent full-canvas frame. Fit the
      // painted card rather than that empty frame, without changing its layout.
      const boxes = [...sample.querySelectorAll<HTMLElement>("div,section,svg")].filter(element => {
        const css = getComputedStyle(element);
        return css.display !== "none" && css.visibility !== "hidden" && Number(css.opacity) > 0
          && (css.backgroundImage !== "none" || (css.backgroundColor !== "rgba(0, 0, 0, 0)" && css.backgroundColor !== "transparent"));
      }).map(element => element.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
      if (!boxes.length) return;
      const origin = sample.getBoundingClientRect(), scale = currentScale.current;
      const x = Math.max(0, (Math.min(...boxes.map(box => box.left)) - origin.left) / scale - 4);
      const y = Math.max(0, (Math.min(...boxes.map(box => box.top)) - origin.top) / scale - 4);
      const width = Math.ceil((Math.max(...boxes.map(box => box.right)) - origin.left) / scale - x + 4);
      const height = Math.ceil((Math.max(...boxes.map(box => box.bottom)) - origin.top) / scale - y + 4);
      setDimensions(old => ["width", "height", "x", "y"].some(key => Math.abs(old[key as keyof typeof old] - ({ width, height, x, y })[key as keyof typeof old]) > 1) ? { width, height, x, y } : old);
      setFit(Math.min(1, (host.clientWidth - 24) / width, (host.clientHeight - 24) / height));
    };
    const resize = new ResizeObserver(measure); resize.observe(host); resize.observe(sample);
    const changes = new MutationObserver(measure); changes.observe(sample, { subtree: true, childList: true, characterData: true });
    measure(); return () => { resize.disconnect(); changes.disconnect(); };
  }, [widget, scenario, revision, theme]);
  const scale = actual ? 1 : fit; currentScale.current = scale;
  return <div ref={stage} role="img" aria-label={`${guide.name}, ${scenario} sample preview`} className={`ov-theme-preview relative min-w-0 overflow-auto rounded-lg border border-border ${small ? "h-40" : "aspect-video"}`} style={CHECKERBOARD} tabIndex={actual ? 0 : undefined}>
    <div inert className="relative" style={{ width: dimensions.width, height: dimensions.height, ...themeToCssVars(theme), position: actual ? "relative" : "absolute", top: actual ? 12 : "50%", left: actual ? 12 : "50%", transform: actual ? "none" : `translate(-50%,-50%) scale(${scale})`, transformOrigin: "center", contain: "layout paint" } as CSSProperties}>
      <div ref={card} style={{ position: "absolute", left: -dimensions.x, top: -dimensions.y, width: guide.recommendedSize.width, height: guide.recommendedSize.height }}>
        <PlaygroundWidget key={`${widget}:${scenario}:${revision}`} widget={widget} scenario={scenario} revision={revision} />
      </div>
    </div>
  </div>;
}

export function WidgetPlayground({ initialWidget = "opponent", compact = false }: { initialWidget?: string; compact?: boolean }) {
  const [widget, setWidget] = useState<WidgetId | "all">(ALL_WIDGETS.includes(initialWidget as WidgetId) ? initialWidget as WidgetId : "opponent");
  const [scenario, setScenario] = useState("victory"), [preset, setPreset] = useState("default"), [revision, replay] = useState(0), [actual, setActual] = useState(false);
  const theme = OVERLAY_THEME_PRESETS.find(item => item.id === preset)?.theme ?? {};
  return <section aria-label="Widget playground" className="min-w-0 space-y-4"><style>{PREVIEW_CSS}</style>
    <div role="status" className="rounded-lg border border-accent/40 bg-accent/5 p-3 text-caption text-text">Local preview · sample data. Nothing is sent to OBS. No account or overlay token is used.</div>
    <div className={`grid min-w-0 gap-4 ${compact ? "" : "lg:grid-cols-[15rem_minmax(0,1fr)]"}`}>
      <div className="min-w-0 space-y-3"><label className="block text-caption font-semibold">Widget<select value={widget} onChange={event => { setWidget(event.target.value as WidgetId | "all"); setActual(false); }} className="mt-1 min-h-11 w-full rounded border border-border bg-bg-surface px-2 text-text"><option value="all">Show all together</option>{WIDGET_GROUPS.map(group => <optgroup key={group.id} label={group.name}>{WIDGET_GUIDES.filter(item => item.group === group.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}</select></label>
        <label className="block text-caption font-semibold">Theme preset<select value={preset} onChange={event => setPreset(event.target.value)} className="mt-1 min-h-11 w-full rounded border border-border bg-bg-surface px-2 text-text">{OVERLAY_THEME_PRESETS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div role="group" aria-label="Sample scenario" className="flex flex-wrap gap-1">{OVERLAY_SAMPLE_SCENARIOS.map(item => <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} className={`min-h-11 rounded border px-2 text-caption ${scenario === item.id ? "border-accent text-accent" : "border-border text-text-muted"}`}>{item.label}</button>)}</div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => replay(value => value + 1)}>Replay sample</Button>{widget !== "all" ? <Button variant="ghost" aria-pressed={actual} onClick={() => setActual(value => !value)}>{actual ? "Fit preview" : "Actual size"}</Button> : null}</div>
        <p className="text-caption text-text-muted">Timed samples can finish; Replay sample starts them again. Actual size lets you scroll within the stage. Preview is silent; Test in OBS checks the real source.</p>
      </div>
      <div className="min-w-0">{widget === "all" ? <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">{ALL_WIDGETS.map(id => <div key={id} className="min-w-0"><p className="mb-1 text-caption font-semibold">{WIDGET_GUIDES.find(item => item.id === id)?.name}</p><SampleStage widget={id} scenario={scenario} theme={theme} revision={revision} small /></div>)}</div> : <SampleStage key={widget} widget={widget} scenario={scenario} theme={theme} revision={revision} actual={actual} />}</div>
    </div>
  </section>;
}
