"use client";

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CompositeTestWidgets } from "@/components/overlay/CompositeTestWidgets";
import { localPreviewRandomizer } from "@/components/overlay/OverlayLocalPreviewFrame";
import type { WidgetId } from "@/components/overlay/widgetLifecycle";
import { LAYOUT_WIDGETS, type OverlayLayout, type WidgetPlacement } from "@/lib/overlayLayout";
import { CHECKERBOARD } from "@/lib/overlayPreviewStyles";
import { overlaySample } from "@/lib/overlaySamples";
import { themeToCssVars, type OverlayTheme } from "@/lib/overlayTheme";
import { defaultWidgetPlacement, moveWidget, type CanvasSize, type PreviewBox } from "./overlayCanvasGeometry";

export type PreviewBoxes = Partial<Record<WidgetId, PreviewBox>>;
type Drag = { pointerId: number; widget: WidgetId; x: number; y: number; placement: WidgetPlacement };
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

function getBoxes(board: HTMLElement): PreviewBoxes {
  const canvas = board.getBoundingClientRect();
  if (!canvas.width || !canvas.height) return {};
  const round = (value: number) => Math.round(value * 10000) / 100;
  const boxes: PreviewBoxes = {};
  for (const item of board.querySelectorAll<HTMLElement>("[data-layout-widget]")) {
    const widget = item.dataset.layoutWidget as WidgetId;
    const rect = item.querySelector(".widget-shell")?.getBoundingClientRect() ?? item.firstElementChild?.getBoundingClientRect();
    if (rect?.width && rect.height) boxes[widget] = {
      left: round((rect.left - canvas.left) / canvas.width), top: round((rect.top - canvas.top) / canvas.height),
      width: round(rect.width / canvas.width), height: round(rect.height / canvas.height),
    };
  }
  return boxes;
}

type Props = {
  size: CanvasSize; layout: OverlayLayout | undefined; theme: OverlayTheme;
  selected: WidgetId; boxes: PreviewBoxes; snap: boolean; names: ReadonlyMap<WidgetId, string>;
  onSelect: (widget: WidgetId) => void; onMeasure: (boxes: PreviewBoxes) => void;
  onPlace: (widget: WidgetId, placement: WidgetPlacement) => void;
};

export function OverlayLayoutCanvas({ size, layout, theme, selected, boxes, snap, names, onSelect, onMeasure, onPlace }: Props) {
  const holder = useRef<HTMLDivElement>(null), board = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [scale, setScale] = useState(0.3);
  const live = useMemo(() => overlaySample(undefined, "victory"), []);
  const randomizer = useMemo(localPreviewRandomizer, []);

  useLayoutEffect(() => {
    const host = holder.current, stage = board.current;
    if (!host || !stage) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => onMeasure(getBoxes(stage)));
    };
    const resize = new ResizeObserver(() => {
      setScale(host.clientWidth / size.width);
      measure();
    });
    resize.observe(host);
    const content = new MutationObserver(measure);
    content.observe(stage, { childList: true, subtree: true });
    setScale(host.clientWidth / size.width);
    measure();
    return () => { resize.disconnect(); content.disconnect(); window.cancelAnimationFrame(frame); };
  }, [size.width, onMeasure]);

  useLayoutEffect(() => {
    const stage = board.current;
    if (stage) onMeasure(getBoxes(stage));
  }, [layout, theme, scale, onMeasure]);

  const placementFor = (widget: WidgetId) => layout?.[widget] ?? defaultWidgetPlacement(boxes[widget]);

  function startDrag(event: PointerEvent<HTMLButtonElement>, widget: WidgetId) {
    if (event.button !== 0 || drag.current) return;
    onSelect(widget);
    drag.current = { pointerId: event.pointerId, widget, x: event.clientX, y: event.clientY, placement: placementFor(widget) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    const rect = board.current?.getBoundingClientRect();
    if (!active || active.pointerId !== event.pointerId || !rect?.width || !rect.height) return;
    const dx = (event.clientX - active.x) * size.width / rect.width;
    const dy = (event.clientY - active.y) * size.height / rect.height;
    onPlace(active.widget, moveWidget(active.placement, dx, dy, size, snap));
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  function nudge(event: KeyboardEvent<HTMLButtonElement>, widget: WidgetId) {
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    onSelect(widget);
    onPlace(widget, moveWidget(placementFor(widget), direction[0] * step, direction[1] * step, size));
  }

  return <div ref={holder} className="relative w-full overflow-hidden rounded-lg border border-border"
    style={{ ...CHECKERBOARD, aspectRatio: `${size.width} / ${size.height}` }}>
    <div ref={board} className="absolute left-0 top-0 origin-top-left overflow-hidden [&_.widget-shell]:!transition-none"
      style={{ width: size.width, height: size.height, transform: `scale(${scale})`, ...themeToCssVars(theme) }}>
      <SafeZones />
      <div inert aria-hidden className="pointer-events-none absolute inset-0">
        <CompositeTestWidgets live={live} session={live.session ?? null} randomizer={randomizer} targets={() => true} layout={layout} />
      </div>
      {LAYOUT_WIDGETS.map(widget => {
        const placement = placementFor(widget);
        const box = boxes[widget];
        const fallbackTop = placement.anchor === "top" ? placement.yPct : placement.yPct < 8 ? 92 : 100 - placement.yPct - 8;
        const geometry = box ?? { left: placement.xPct - 7, top: fallbackTop, width: 14, height: 8 };
        return <button key={widget} type="button" aria-label={`Move ${names.get(widget) ?? widget}`} aria-pressed={selected === widget}
          aria-describedby="layout-move-help" className={`absolute touch-none cursor-move rounded-md border-2 outline-none focus-visible:ring-4 focus-visible:ring-accent ${selected === widget ? "border-accent bg-accent/10" : "border-transparent hover:border-accent/70"}`}
          style={{ left: `${geometry.left}%`, top: `${geometry.top}%`, width: `${geometry.width}%`, height: `${geometry.height}%`, zIndex: selected === widget ? 90 : 50 + placement.zIndex }}
          onClick={() => onSelect(widget)} onFocus={() => onSelect(widget)} onKeyDown={event => nudge(event, widget)}
          onPointerDown={event => startDrag(event, widget)} onPointerMove={continueDrag}
          onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} />;
      })}
    </div>
  </div>;
}

function SafeZones() {
  const areas = [
    { name: "Minimap", className: "bottom-0 left-0 h-[22%] w-[19%]" },
    { name: "Command card", className: "bottom-0 right-0 h-[20%] w-[23%]" },
    { name: "Resources and supply", className: "right-0 top-0 h-[9%] w-[32%]" },
  ];
  return <div aria-hidden className="pointer-events-none absolute inset-0">
    {areas.map(area => <span key={area.name} className={`absolute grid place-items-center border-2 border-dashed border-warning/70 bg-warning/20 p-2 text-center text-h2 font-semibold text-text ${area.className}`}>{area.name}</span>)}
  </div>;
}
