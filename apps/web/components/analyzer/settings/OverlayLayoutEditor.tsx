"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { LAYOUT_LIMITS, LAYOUT_WIDGETS, type OverlayCanvas, type OverlayLayout, type WidgetPlacement } from "@/lib/overlayLayout";
import type { OverlayProfile } from "@/lib/overlayProfile";
import { WIDGET_GUIDES } from "@/lib/streamStudioLearn";
import type { WidgetId } from "@/components/overlay/widgetLifecycle";
import { OverlayLayoutCanvas, type PreviewBoxes } from "./OverlayLayoutCanvas";
import { CANVAS_SIZE, changeWidgetAnchor, defaultWidgetPlacement } from "./overlayCanvasGeometry";
import { UrlRow } from "./OverlayUrlRow";

const NAMES = new Map<WidgetId, string>(WIDGET_GUIDES.map(guide => [guide.id, guide.name]));
const CONTROL = "min-h-11 w-full rounded-md border border-border bg-bg-surface px-3 text-body text-text";
export type SetOverlayLayout = (canvas: OverlayCanvas, update: (layout: OverlayLayout) => OverlayLayout) => void;

export function OverlayLayoutEditor({ profile, onChange, token, origin, disabled }: {
  profile: OverlayProfile; onChange: SetOverlayLayout; token: string; origin?: string; disabled?: boolean;
}) {
  const [canvas, setCanvas] = useState<OverlayCanvas>("landscape");
  const [selected, setSelected] = useState<WidgetId>("opponent");
  const [snap, setSnap] = useState(true);
  const [boxes, setBoxes] = useState<PreviewBoxes>({});
  const layout = canvas === "vertical" ? profile.layoutVertical : profile.layout;
  const placement = layout?.[selected] ?? defaultWidgetPlacement(boxes[selected]);
  const size = CANVAS_SIZE[canvas];
  const measure = useCallback((next: PreviewBoxes) => setBoxes(previous =>
    JSON.stringify(previous) === JSON.stringify(next) ? previous : next), []);

  const place = (widget: WidgetId, next: WidgetPlacement) => {
    if (!disabled) onChange(canvas, current => ({ ...current, [widget]: next }));
  };
  const resetWidget = () => onChange(canvas, current => {
    const next = { ...current };
    delete next[selected];
    return next;
  });

  return <fieldset disabled={disabled} aria-label="Arrange All-in-one widgets" className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-2" role="group" aria-label="Canvas orientation">
      <Button type="button" variant={canvas === "landscape" ? "primary" : "secondary"} aria-pressed={canvas === "landscape"} onClick={() => setCanvas("landscape")}>Landscape</Button>
      <Button type="button" variant={canvas === "vertical" ? "primary" : "secondary"} aria-pressed={canvas === "vertical"} onClick={() => setCanvas("vertical")}>Vertical</Button>
    </div>
    <p id="layout-move-help" className="text-caption text-text-muted">Drag a widget, or focus it and use the arrow keys to move 1 pixel. Hold Shift to move 10 pixels. The shaded areas mark the minimap, command card, and resources and supply.</p>
    <div className={canvas === "vertical" ? "mx-auto w-full max-w-[340px]" : "w-full"}>
      <OverlayLayoutCanvas key={canvas} size={size} layout={layout} theme={profile.theme} selected={selected} boxes={boxes}
        snap={snap} names={NAMES} onSelect={setSelected} onMeasure={measure} onPlace={place} />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="space-y-1 text-caption text-text">Widget
        <select className={CONTROL} value={selected} onChange={event => setSelected(event.target.value as WidgetId)}>
          {LAYOUT_WIDGETS.map(widget => <option key={widget} value={widget}>{NAMES.get(widget) ?? widget}</option>)}
        </select>
      </label>
      <label className="space-y-1 text-caption text-text">Anchor
        <select className={CONTROL} value={placement.anchor} onChange={event => place(selected, changeWidgetAnchor(placement, event.target.value === "bottom" ? "bottom" : "top", boxes[selected]))}>
          <option value="top">Top</option><option value="bottom">Bottom</option>
        </select>
      </label>
      <label className="space-y-1 text-caption text-text">Scale {Math.round(placement.scale * 100)}%
        <input className="block min-h-11 w-full accent-current" type="range" min={LAYOUT_LIMITS.minScale} max={LAYOUT_LIMITS.maxScale} step={0.05}
          value={placement.scale} onChange={event => place(selected, { ...placement, scale: event.currentTarget.valueAsNumber })} />
      </label>
      <label className="space-y-1 text-caption text-text">Layer
        <input className={CONTROL} type="number" min={0} max={LAYOUT_LIMITS.maxLayer} step={1} value={placement.zIndex} onChange={event => {
          const zIndex = event.currentTarget.valueAsNumber;
          if (Number.isInteger(zIndex) && zIndex >= 0 && zIndex <= LAYOUT_LIMITS.maxLayer) place(selected, { ...placement, zIndex });
        }} />
      </label>
    </div>
    <label className="flex min-h-11 items-center gap-2 text-caption text-text"><input type="checkbox" checked={snap} onChange={event => setSnap(event.target.checked)} />Snap drag to 8 pixels</label>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" disabled={!layout?.[selected]} onClick={resetWidget}>Reset widget</Button>
      <Button type="button" variant="secondary" disabled={!layout || !Object.keys(layout).length} onClick={() => onChange(canvas, () => ({}))}>Reset layout to default</Button>
    </div>
    {canvas === "vertical" ? <div className="space-y-2 border-t border-border pt-3">
      <p className="text-caption text-text-muted">Use a {size.width} × {size.height} Browser Source in OBS for this vertical URL.</p>
      <UrlRow url={`${origin ?? ""}/overlay/${encodeURIComponent(token)}?canvas=vertical`} compact={false} />
    </div> : null}
  </fieldset>;
}
