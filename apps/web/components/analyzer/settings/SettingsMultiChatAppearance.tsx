"use client";

/**
 * Settings · Overlay · Multi-platform chat · Appearance.
 *
 * Controlled styling editor for the multichat widget with a
 * pixel-honest live preview: the preview renders through the SAME
 * MultiChatMessageList component the OBS Browser Source uses, over a
 * checkerboard so background transparency is visible.
 *
 * The parent (SettingsMultiChat) owns the draft + Save — appearance
 * is part of the same /v1/me/preferences/multichat blob as the
 * channel config, so one Save covers both and the widget picks
 * everything up within a minute.
 */

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import {
  ALIGNMENTS,
  DEFAULT_APPEARANCE,
  DENSITIES,
  ENTRY_ANIMATIONS,
  FONT_FAMILIES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_WEIGHTS,
  LAYOUTS,
  MAX_VISIBLE_MAX,
  MAX_VISIBLE_MIN,
  NEWEST_AT,
  RADIUS_MAX,
  TTL_MAX_SEC,
  USERNAME_STYLES,
  appearanceStyles,
  visibleMessages,
  type ChatAppearance,
} from "@/lib/multichat/appearance";
import type { ChatMessage } from "@/lib/multichat/types";
import { MultiChatMessageList } from "@/components/overlay/widgets/MultiChatMessageList";

const LABELS: Record<string, string> = {
  // fonts
  inter: "Default (Inter)",
  system: "System",
  rounded: "Rounded",
  mono: "Monospace",
  serif: "Serif",
  // weights
  normal: "Normal",
  medium: "Medium",
  bold: "Bold",
  // density
  compact: "Compact",
  cozy: "Cozy",
  comfortable: "Comfortable",
  // layout
  rows: "Single line",
  "two-line": "Name above message",
  bubbles: "Bubbles",
  // newestAt
  bottom: "Bottom (classic chat)",
  top: "Top (news ticker)",
  // align
  left: "Left",
  right: "Right",
  // username styles
  platform: "Author colours",
  uniform: "Overlay accent",
  white: "Plain white",
  // animations
  fade: "Fade in",
  "slide-up": "Slide up",
  "slide-left": "Slide in from right",
  pop: "Pop",
  none: "None",
};

/**
 * Preview lines — clearly-labeled sample content rendered ONLY inside
 * this settings preview (the widget itself never synthesises chat).
 * Ages are staggered so timestamp + TTL settings demonstrate honestly.
 */
function previewMessages(nowMs: number): ChatMessage[] {
  return [
    {
      platform: "twitch",
      id: "p1",
      user: "PreviewViewer",
      text: "This is exactly how your merged chat will render.",
      color: "#FF69B4",
      badges: [],
      atMs: nowMs - 95_000,
    },
    {
      platform: "kick",
      id: "p2",
      user: "KickFan",
      text: "Kick lines carry the green chip.",
      color: "#75FD48",
      badges: ["member"],
      atMs: nowMs - 60_000,
    },
    {
      platform: "youtube",
      id: "p3",
      user: "YT Regular",
      text: "YouTube and TikTok get readable auto-colours :fire:",
      badges: ["member"],
      atMs: nowMs - 32_000,
    },
    {
      platform: "tiktok",
      id: "p4",
      user: "tik.viewer",
      text: "!commands disappear if you hide them below",
      badges: [],
      atMs: nowMs - 18_000,
    },
    {
      platform: "twitch",
      id: "p5",
      user: "ModFriend",
      text: "badges and long messages wrap without stretching the panel — resize the source in OBS and the text follows along.",
      color: "#1E90FF",
      badges: ["moderator"],
      atMs: nowMs - 4_000,
    },
  ];
}

export function SettingsMultiChatAppearance({
  value,
  onChange,
}: {
  value: ChatAppearance;
  onChange: (next: ChatAppearance) => void;
}) {
  const set = (patch: Partial<ChatAppearance>) =>
    onChange({ ...value, ...patch });

  // Recomputed per render — changing any control refreshes the ages,
  // so a TTL of e.g. 30s honestly drops the older sample lines.
  const now = Date.now();
  const preview = useMemo(
    () => visibleMessages(previewMessages(now), value, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value],
  );
  const previewStyles = appearanceStyles(value);

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-body font-medium text-text">Appearance</div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
          Reset to defaults
        </Button>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <ControlGroup title="Text">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Font"
                value={value.fontFamily}
                options={FONT_FAMILIES}
                onChange={(v) => set({ fontFamily: v })}
              />
              <SelectField
                label="Message weight"
                value={value.fontWeight}
                options={FONT_WEIGHTS}
                onChange={(v) => set({ fontWeight: v })}
              />
              <SliderField
                label="Text size"
                value={value.fontSize}
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                unit="px"
                onChange={(v) => set({ fontSize: v })}
              />
              <SelectField
                label="Spacing"
                value={value.density}
                options={DENSITIES}
                onChange={(v) => set({ density: v })}
              />
              <SelectField
                label="Username colour"
                value={value.usernameStyle}
                options={USERNAME_STYLES}
                onChange={(v) => set({ usernameStyle: v })}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <ToggleField
                label="Text shadow"
                hint="keeps text readable at low background opacity"
                checked={value.textShadow}
                onChange={(on) => set({ textShadow: on })}
              />
              <ToggleField
                label="Timestamps"
                checked={value.showTimestamps}
                onChange={(on) => set({ showTimestamps: on })}
              />
            </div>
          </ControlGroup>

          <ControlGroup title="Layout">
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Message layout"
                value={value.layout}
                options={LAYOUTS}
                onChange={(v) => set({ layout: v })}
              />
              <SelectField
                label="How messages appear"
                value={value.entryAnimation}
                options={ENTRY_ANIMATIONS}
                onChange={(v) => set({ entryAnimation: v })}
              />
              <SelectField
                label="New messages at"
                value={value.newestAt}
                options={NEWEST_AT}
                onChange={(v) => set({ newestAt: v })}
              />
              <SelectField
                label="Alignment"
                value={value.align}
                options={ALIGNMENTS}
                onChange={(v) => set({ align: v })}
              />
              <SliderField
                label="Messages kept on screen"
                value={value.maxVisible}
                min={MAX_VISIBLE_MIN}
                max={MAX_VISIBLE_MAX}
                onChange={(v) => set({ maxVisible: v })}
              />
              <SliderField
                label="Hide messages after"
                value={value.messageTtlSec}
                min={0}
                max={TTL_MAX_SEC}
                step={5}
                unit="s"
                zeroLabel="never"
                onChange={(v) => set({ messageTtlSec: v })}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <ToggleField
                label="Platform chips"
                hint="the TW / KK / YT / TT tags"
                checked={value.showPlatformChips}
                onChange={(on) => set({ showPlatformChips: on })}
              />
              <ToggleField
                label="Role badges"
                hint="mod / sub / broadcaster glyphs"
                checked={value.showBadges}
                onChange={(on) => set({ showBadges: on })}
              />
            </div>
          </ControlGroup>

          <ControlGroup title="Background & frame">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <FieldLabel>Background colour</FieldLabel>
                <input
                  type="color"
                  value={value.bgColor}
                  onChange={(e) => set({ bgColor: e.target.value })}
                  className="h-9 w-16 cursor-pointer rounded border border-border bg-bg-elevated p-1"
                  aria-label="Background colour"
                />
              </div>
              <SliderField
                label="Background opacity"
                value={value.bgOpacity}
                min={0}
                max={100}
                unit="%"
                zeroLabel="fully transparent"
                onChange={(v) => set({ bgOpacity: v })}
              />
              <SliderField
                label="Corner radius"
                value={value.cornerRadius}
                min={0}
                max={RADIUS_MAX}
                unit="px"
                onChange={(v) => set({ cornerRadius: v })}
              />
            </div>
            <div className="mt-3">
              <ToggleField
                label="Panel border"
                checked={value.panelBorder}
                onChange={(on) => set({ panelBorder: on })}
              />
            </div>
          </ControlGroup>

          <ControlGroup title="Filters">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <ToggleField
                label="Hide !commands"
                checked={value.hideCommands}
                onChange={(on) => set({ hideCommands: on })}
              />
              <ToggleField
                label="Hide known bots"
                hint="Nightbot, StreamElements, …"
                checked={value.hideBots}
                onChange={(on) => set({ hideBots: on })}
              />
            </div>
            <div className="mt-3 min-w-0">
              <FieldLabel>Also hide these users (comma-separated)</FieldLabel>
              <input
                type="text"
                value={value.blockedUsers}
                onChange={(e) => set({ blockedUsers: e.target.value })}
                placeholder="e.g. mybot, spamaccount"
                className="w-full min-w-0 max-w-md rounded-lg border border-border bg-bg-elevated px-3 py-1.5 text-body text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </div>
          </ControlGroup>
        </div>

        {/* Live preview — same renderer as OBS, over a checkerboard so
            transparency reads honestly. */}
        <div className="min-w-0">
          <FieldLabel>Live preview</FieldLabel>
          <div
            className="overflow-hidden rounded-lg border border-border"
            style={{
              background:
                "repeating-conic-gradient(#2a2f3a 0% 25%, #1c212b 0% 50%) 0 0 / 18px 18px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: 320,
                background: previewStyles.panelBackground,
                border: value.panelBorder
                  ? "1px solid rgba(255,255,255,0.10)"
                  : "none",
                borderRadius: value.cornerRadius,
                // Same shadow rule the OBS shell applies — the preview
                // must stay pixel-honest.
                boxShadow:
                  value.bgOpacity > 5 ? "0 6px 20px rgba(0,0,0,0.45)" : "none",
                margin: 10,
                overflow: "hidden",
              }}
            >
              <MultiChatMessageList
                messages={preview}
                appearance={value}
                emptyText="Every sample line is filtered out — relax a filter to see the preview."
              />
            </div>
          </div>
          <p className="mt-1.5 text-micro text-text-dim">
            Sample lines for styling only — your OBS source shows real chat.
            The checkerboard shows through wherever the background is
            transparent.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ──────────────── small controls ──────────────── */

function ControlGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-3">
      <legend className="px-1 text-micro font-semibold uppercase tracking-wider text-text-dim">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-caption text-text-dim">{children}</div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="block min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="w-full min-w-0 rounded-lg border border-border bg-bg-elevated px-2.5 py-1.5 text-body text-text focus:border-accent focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {LABELS[opt] ?? opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  zeroLabel,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  zeroLabel?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block min-w-0">
      <FieldLabel>
        {label}{" "}
        <span className="tabular-nums text-text">
          {value === 0 && zeroLabel ? zeroLabel : `${value}${unit}`}
        </span>
      </FieldLabel>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent,#3ec0c7)]"
      />
    </label>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span className="text-caption text-text">
        {label}
        {hint ? (
          <span className="ml-1 text-text-dim">· {hint}</span>
        ) : null}
      </span>
    </div>
  );
}
