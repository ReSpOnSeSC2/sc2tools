"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { worksheetImage } from "./lockerWorksheetModel";

type Point = { x: number; y: number };
type Tool = "circle" | "arrow" | "pen";
type Mark = { tool: Tool; points: Point[] };
const TOOLS: Tool[] = ["circle", "arrow", "pen"];
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function drawMark(context: CanvasRenderingContext2D, mark: Mark) {
  const first = mark.points[0], last = mark.points.at(-1)!;
  context.beginPath();
  if (mark.tool === "circle") {
    context.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2,
      Math.abs(first.x - last.x) / 2 + 6, Math.abs(first.y - last.y) / 2 + 6, 0, 0, 2 * Math.PI);
  } else if (mark.tool === "arrow") {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    context.moveTo(first.x, first.y); context.lineTo(last.x, last.y);
    for (const offset of [-0.5, 0.5]) {
      context.moveTo(last.x, last.y);
      context.lineTo(last.x - 18 * Math.cos(angle + offset), last.y - 18 * Math.sin(angle + offset));
    }
  } else {
    context.moveTo(first.x, first.y);
    mark.points.forEach(point => context.lineTo(point.x, point.y));
  }
  context.stroke();
}

export function LockerWorksheetAnnotation({ existing, onSave, onCancel }: {
  existing?: string | null;
  onSave: (data: string) => void;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const base = useRef<HTMLImageElement | null>(null);
  const marks = useRef<Mark[]>([]);
  const drawing = useRef<Mark | null>(null);
  const loadEpoch = useRef(0);
  const keyboard = useRef<Point>({ x: 600, y: 280 });
  const [tool, setTool] = useState<Tool>("circle");
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState("");

  const paint = useCallback((cursor?: Point) => {
    const target = canvas.current;
    const context = target?.getContext("2d");
    if (!target || !context) return;
    context.clearRect(0, 0, target.width, target.height);
    const image = base.current;
    if (image) context.drawImage(image, 0, 0, target.width, target.height);
    context.strokeStyle = getComputedStyle(target).getPropertyValue("--accent").trim() || "gold";
    context.lineCap = "round";
    context.lineWidth = 4;
    marks.current.forEach(mark => drawMark(context, mark));
    if (cursor) {
      context.beginPath(); context.arc(cursor.x, cursor.y, 8, 0, Math.PI * 2); context.stroke();
    }
  }, []);

  const load = useCallback((source: string, release: () => void = () => {}) => {
    const epoch = ++loadEpoch.current;
    const image = new Image();
    image.onload = () => {
      release();
      if (epoch !== loadEpoch.current || !canvas.current || !image.naturalWidth || !image.naturalHeight) return;
      const target = canvas.current;
      const scale = Math.min(1, 1200 / image.naturalWidth, 900 / image.naturalHeight);
      target.width = Math.max(1, Math.round(image.naturalWidth * scale));
      target.height = Math.max(1, Math.round(image.naturalHeight * scale));
      keyboard.current = { x: target.width / 2, y: target.height / 2 };
      base.current = image;
      marks.current = [];
      drawing.current = null;
      setReady(true); setCount(0); setError(""); paint();
    };
    image.onerror = () => { release(); if (epoch === loadEpoch.current) setError("This screenshot could not be opened."); };
    image.src = source;
  }, [paint]);

  const openFile = useCallback((file?: File) => {
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) { setError("Choose a PNG, JPEG or WebP screenshot."); return; }
    const source = URL.createObjectURL(file);
    load(source, () => URL.revokeObjectURL(source));
  }, [load]);

  useEffect(() => {
    const source = worksheetImage(existing);
    if (source) load(source);
    const paste = (event: ClipboardEvent) => {
      const image = [...(event.clipboardData?.files ?? [])].find(file => IMAGE_TYPES.has(file.type));
      if (image) { event.preventDefault(); openFile(image); }
    };
    document.addEventListener("paste", paste);
    return () => { loadEpoch.current++; document.removeEventListener("paste", paste); };
  }, [existing, load, openFile]);

  function position(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const { width, height } = event.currentTarget;
    const scale = Math.min(rect.width / width, rect.height / height) || 1;
    const x = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale;
    const y = (event.clientY - rect.top - (rect.height - height * scale) / 2) / scale;
    return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) };
  }
  const start = (point: Point) => {
    const mark = { tool, points: [point, point] };
    marks.current.push(mark); drawing.current = mark; setCount(marks.current.length);
  };
  const move = (point: Point) => {
    const mark = drawing.current;
    if (!mark) return;
    if (mark.tool === "pen") mark.points.push(point);
    else mark.points[1] = point;
  };

  return <div className="space-y-3">
    <Field label="Upload a screenshot" hint="You can also paste a screenshot."><Input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => openFile(event.target.files?.[0])} /></Field>
    <div role="group" aria-label="Drawing tools" className="flex flex-wrap gap-2">
      {TOOLS.map(value => <Button key={value} size="sm" variant={tool === value ? "secondary" : "ghost"} aria-pressed={tool === value}
        onClick={() => { drawing.current = null; setTool(value); }}>{value[0].toUpperCase() + value.slice(1)}</Button>)}
      <Button size="sm" variant="ghost" disabled={!count} onClick={() => {
        drawing.current = null; marks.current.pop(); setCount(marks.current.length); paint();
      }}>Undo mark</Button>
    </div>
    <p className="text-caption text-text-muted" id="worksheet-drawing-keys">Drag to draw. With the canvas focused, use the arrow keys to move and Space to start or finish a mark.</p>
    <canvas ref={canvas} width={1200} height={560} tabIndex={0} aria-label="Screenshot annotation canvas" aria-describedby="worksheet-drawing-keys"
      className="block max-h-[55vh] w-full touch-none rounded-lg border border-border bg-bg-elevated object-contain focus-visible:outline focus-visible:outline-accent"
      onPointerDown={event => {
        if (!ready || event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId); start(position(event)); paint();
      }}
      onPointerMove={event => { if (drawing.current) { move(position(event)); paint(); } }}
      onPointerUp={event => { if (drawing.current) { move(position(event)); drawing.current = null; paint(); } }}
      onPointerCancel={() => { if (drawing.current) { drawing.current = null; marks.current.pop(); setCount(marks.current.length); paint(); } }}
      onFocus={() => { if (ready) paint(keyboard.current); }} onBlur={() => paint()}
      onKeyDown={event => {
        if (!ready) return;
        const directions: Record<string, Point> = { ArrowLeft: { x: -12, y: 0 }, ArrowRight: { x: 12, y: 0 }, ArrowUp: { x: 0, y: -12 }, ArrowDown: { x: 0, y: 12 } };
        const delta = directions[event.key];
        if (delta) {
          event.preventDefault();
          const point = keyboard.current;
          keyboard.current = { x: Math.max(0, Math.min(event.currentTarget.width, point.x + delta.x)),
            y: Math.max(0, Math.min(event.currentTarget.height, point.y + delta.y)) };
          move(keyboard.current); paint(keyboard.current);
        } else if (event.key === " " && !event.repeat) {
          event.preventDefault();
          if (drawing.current) drawing.current = null;
          else start(keyboard.current);
          paint(keyboard.current);
        }
      }} />
    {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!ready} onClick={() => { paint(); const data = canvas.current?.toDataURL("image/jpeg", 0.85); if (worksheetImage(data)) onSave(data!); }}>Save annotation</Button>
      <Button variant="secondary" onClick={onCancel}>Cancel annotation</Button>
    </div>
  </div>;
}
