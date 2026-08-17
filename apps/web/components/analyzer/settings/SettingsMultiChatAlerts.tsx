"use client";

/**
 * Settings · Overlay · Multi-platform chat · Alert visuals.
 *
 * One controlled editor for the visual treatment shared by follows, subs,
 * raids and every other normalized platform event. The parent owns the draft
 * and Save flow; this surface only edits a complete, sanitized AlertVisualConfig.
 */

import { useEffect, useMemo, useState } from "react";
import { Dices, RotateCcw, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { ChatAlertCard } from "@/components/overlay/widgets/ChatAlertCard";
import { useApi } from "@/lib/clientApi";
import { setAlertMediaGrant, toAlertMediaGrant } from "@/lib/multichat/mediaBase";
import {
  ALERT_VISUAL_CATEGORIES,
  ALERT_VISUAL_PRESET_BY_ID,
  visiblePresetsFor,
  DEFAULT_ALERTS,
  RECOMMENDED_EVENT_VISUALS,
  resolveAlertVisualPreset,
  type AlertConfig,
  type AlertVisualMotion,
  type AlertVisualPreset,
  type AlertVisualSelection,
} from "@/lib/multichat/alerts";
import {
  CHAT_EVENT_KINDS,
  EVENT_KIND_LABEL,
  type ChatEvent,
  type ChatEventKind,
} from "@/lib/multichat/events";

const MOTION_OPTIONS: ReadonlyArray<{
  id: AlertVisualMotion;
  label: string;
  description: string;
}> = [
  { id: "subtle", label: "Subtle", description: "Gentle entrance, calm decorations" },
  { id: "full", label: "Full", description: "The complete preset choreography" },
  { id: "maximum", label: "Maximum", description: "Extra movement and celebratory energy" },
];

const PREVIEW_EVENT_COPY: Record<
  ChatEventKind,
  Pick<ChatEvent, "platform" | "user" | "detail" | "amount">
> = {
  sub: {
    platform: "twitch",
    user: "PreviewSubscriber",
    detail: "just joined the squad",
  },
  resub: {
    platform: "twitch",
    user: "LoyalViewer",
    detail: "resubscribed for 12 months",
    amount: "12 months",
  },
  giftsub: {
    platform: "twitch",
    user: "GiftCaptain",
    detail: "gifted subscriptions to the community",
    amount: "×10",
  },
  raid: {
    platform: "twitch",
    user: "RaidCommander",
    detail: "brought the whole party",
    amount: "247 raiders",
  },
  member: {
    platform: "youtube",
    user: "NewCrewMember",
    detail: "became a channel member",
  },
  superchat: {
    platform: "youtube",
    user: "GenerousViewer",
    detail: "sent a Super Chat",
    amount: "$25.00",
  },
  gift: {
    platform: "tiktok",
    user: "GiftMachine",
    detail: "sent a galaxy of gifts",
    amount: "×25",
  },
  follow: {
    platform: "kick",
    user: "FreshFollower",
    detail: "followed the channel",
  },
  cheer: {
    platform: "twitch",
    user: "BitBoss",
    detail: "cheered in chat",
    amount: "1,000 bits",
  },
  share: {
    platform: "tiktok",
    user: "SignalBooster",
    detail: "shared the live stream",
  },
  reward: {
    platform: "twitch",
    user: "ChaosViewer",
    detail: "redeemed a channel reward",
    amount: "Hydrate!",
  },
};

function visualMap(selection: AlertVisualSelection): AlertConfig["eventVisuals"] {
  return Object.fromEntries(
    CHAT_EVENT_KINDS.map((kind) => [kind, selection]),
  ) as AlertConfig["eventVisuals"];
}

/**
 * Pick one semantically approved preset per kind while keeping the mix varied.
 *
 * The recommendation pools include the admin-gated SC2 3D presets, so the pool
 * is narrowed to what this account may actually use. Assigning a gated preset
 * to a non-admin would leave the picker showing a value it has no option for,
 * and the renderer would fall back to static art for a choice the user never
 * made. A kind whose entire pool is gated falls back to "shuffle".
 */
function recommendedVisualMap(
  allowed: readonly AlertVisualPreset[],
): AlertConfig["eventVisuals"] {
  const allowedIds = new Set(allowed.map((preset) => preset.id));
  return Object.fromEntries(
    CHAT_EVENT_KINDS.map((kind, index) => {
      const pool = RECOMMENDED_EVENT_VISUALS[kind].filter((id) =>
        allowedIds.has(id),
      );
      if (pool.length === 0) return [kind, "shuffle"];
      return [kind, pool[index % pool.length]];
    }),
  ) as AlertConfig["eventVisuals"];
}

function previewEvent(kind: ChatEventKind): ChatEvent {
  return {
    id: `settings-preview-${kind}`,
    kind,
    atMs: Date.now(),
    ...PREVIEW_EVENT_COPY[kind],
  };
}

export function SettingsMultiChatAlerts({
  value,
  onChange,
}: {
  value: AlertConfig;
  onChange: (next: AlertConfig) => void;
}) {
  // The SC2 3D presets are admin-gated: their media never ships in the public
  // build and only an admin session can presign it. Offering them to everyone
  // would list choices that render as static fallback art for the picker.
  const { data: me } = useApi<{ isAdmin?: boolean }>("/v1/me");
  const isAdmin = Boolean(me?.isAdmin);
  const availablePresets = useMemo(
    () => visiblePresetsFor(isAdmin),
    [isAdmin],
  );
  // Presigned grant for the admin-gated SC2 3D media, so the live preview
  // shows the real render rather than the static fallback. Only requested for
  // an admin; a non-admin would get 403 and see the fallback either way.
  const { data: mediaGrant } = useApi<{ urls?: Record<string, string>; expiresIn?: number }>(
    isAdmin ? "/v1/multichat/alert-media" : null,
    { refreshInterval: 4 * 60 * 1000 },
  );
  useEffect(() => {
    if (mediaGrant) setAlertMediaGrant(toAlertMediaGrant(mediaGrant));
  }, [mediaGrant]);
  const [selectedKind, setSelectedKind] = useState<ChatEventKind>("sub");
  const selection = value.eventVisuals[selectedKind];
  const selectedPreset = useMemo(
    () => resolveAlertVisualPreset(selection, selectedKind, "settings-preview"),
    [selectedKind, selection],
  );
  const event = useMemo(() => previewEvent(selectedKind), [selectedKind]);

  const set = (patch: Partial<AlertConfig>) =>
    onChange({ ...value, ...patch });

  const setKindVisual = (
    kind: ChatEventKind,
    next: AlertVisualSelection,
  ) => {
    setSelectedKind(kind);
    set({ eventVisuals: { ...value.eventVisuals, [kind]: next } });
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-body font-medium text-text">
            <Sparkles className="h-4 w-4 text-accent-cyan" aria-hidden />
            Event alert visuals
          </div>
          <p className="mt-1 max-w-3xl text-caption text-text-dim">
            Give every follow, sub, raid, gift and platform event its own
            on-stream personality. Sound choices stay independent below.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({
            ...DEFAULT_ALERTS,
            eventVisuals: { ...DEFAULT_ALERTS.eventVisuals },
          })}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
          Reset to defaults
        </Button>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <fieldset className="min-w-0 rounded-lg border border-border p-3">
            <legend className="px-1 text-micro font-semibold uppercase tracking-wider text-text-dim">
              Quick setup
            </legend>
            <p className="mb-2 text-caption text-text-dim">
              Start coherent, use our event-aware mix, or keep every alert
              surprising. You can fine-tune individual rows afterward.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => set({ eventVisuals: visualMap("classic") })}
              >
                Classic all
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => set({
                  eventVisuals: recommendedVisualMap(availablePresets),
                })}
              >
                <WandSparkles className="mr-1 h-3.5 w-3.5" aria-hidden />
                Recommended mix
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => set({ eventVisuals: visualMap("shuffle") })}
              >
                <Dices className="mr-1 h-3.5 w-3.5" aria-hidden />
                Shuffle all
              </Button>
            </div>
          </fieldset>

          <fieldset className="min-w-0 rounded-lg border border-border p-3">
            <legend className="px-1 text-micro font-semibold uppercase tracking-wider text-text-dim">
              Playback
            </legend>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
              <div>
                <div className="mb-1 text-caption text-text-dim">Motion</div>
                <div
                  className="grid gap-1.5 sm:grid-cols-3"
                  role="group"
                  aria-label="Alert motion intensity"
                >
                  {MOTION_OPTIONS.map((option) => {
                    const active = value.motion === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={active}
                        title={option.description}
                        onClick={() => set({ motion: option.id })}
                        className={`rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                          active
                            ? "border-accent bg-accent/15 text-text"
                            : "border-border bg-bg-elevated text-text-muted hover:border-border-strong hover:text-text"
                        }`}
                      >
                        <span className="block text-caption font-semibold">
                          {option.label}
                        </span>
                        <span className="mt-0.5 block text-micro leading-snug text-text-dim">
                          {option.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="block min-w-0">
                <div className="mb-1 flex items-baseline justify-between gap-2 text-caption text-text-dim">
                  <span>Time on screen</span>
                  <span className="rounded-full bg-bg-elevated px-2 py-0.5 font-semibold tabular-nums text-text">
                    {value.durationSec} sec
                  </span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={value.durationSec}
                  aria-label="Alert time on screen"
                  aria-valuetext={`${value.durationSec} seconds`}
                  onChange={(e) => set({ durationSec: Number(e.target.value) })}
                  className="w-full accent-[var(--accent,#3ec0c7)]"
                />
                <div className="mt-0.5 flex justify-between text-micro text-text-dim">
                  <span>3s</span>
                  <span>15s</span>
                </div>
              </label>
            </div>

            <div className="mt-3 border-t border-border pt-3">
              <div className="flex items-center gap-2">
                <Toggle
                  checked={value.showHistory}
                  onChange={(showHistory) => set({ showHistory })}
                  label="Show recent alert history"
                />
                <span className="text-caption text-text">
                  Show recent alert history
                  <span className="ml-1 text-text-dim">
                    · keeps up to three faded acknowledgements below the hero alert
                  </span>
                </span>
              </div>
            </div>
          </fieldset>

          <fieldset className="min-w-0 rounded-lg border border-border p-3">
            <legend className="px-1 text-micro font-semibold uppercase tracking-wider text-text-dim">
              Visual by event
            </legend>
            <p className="mb-3 text-caption text-text-dim">
              Select a row to preview it. Smart Shuffle draws from a tailored
              pool, so raids stay huge and money events stay satisfyingly shiny.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {CHAT_EVENT_KINDS.map((kind) => {
                const active = selectedKind === kind;
                const current = value.eventVisuals[kind];
                const currentPreset = current === "shuffle"
                  ? null
                  : ALERT_VISUAL_PRESET_BY_ID[current];
                return (
                  <label
                    key={kind}
                    className={`block min-w-0 rounded-lg border p-2.5 transition-colors ${
                      active
                        ? "border-accent bg-accent/10"
                        : "border-border bg-bg-surface hover:border-border-strong"
                    }`}
                    onPointerDown={() => setSelectedKind(kind)}
                    onFocus={() => setSelectedKind(kind)}
                  >
                    <span className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-caption font-semibold text-text">
                        {EVENT_KIND_LABEL[kind]}
                      </span>
                      <span className="text-micro text-text-dim">
                        {current === "shuffle"
                          ? "smart shuffle"
                          : currentPreset?.category}
                      </span>
                    </span>
                    <select
                      value={current}
                      aria-label={`${EVENT_KIND_LABEL[kind]} alert visual`}
                      onChange={(e) => setKindVisual(
                        kind,
                        e.target.value as AlertVisualSelection,
                      )}
                      className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-caption text-text focus:border-accent focus:outline-none"
                    >
                      <option value="shuffle">🎲 Smart Shuffle</option>
                      {ALERT_VISUAL_CATEGORIES.map((category) => (
                        <optgroup key={category} label={category}>
                          {availablePresets.filter(
                            (preset) => preset.category === category,
                          ).map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {preset.emoji} {preset.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
            <p className="text-caption leading-relaxed text-text-dim">
              <span className="font-semibold text-text">Code-native and VOD-safe.</span>{" "}
              Meme treatments use original CSS art, typography, and emoji—not
              ripped clips or remote GIFs. Optional locally rendered SC2 3D
              media require publication-rights review and fall back to licensed
              local icons. Your separate sound picker still controls what viewers
              hear.
            </p>
          </div>
        </div>

        <AlertPreview
          kind={selectedKind}
          selection={selection}
          preset={selectedPreset}
          event={event}
          motion={value.motion}
        />
      </div>
    </div>
  );
}

function AlertPreview({
  kind,
  selection,
  preset,
  event,
  motion,
}: {
  kind: ChatEventKind;
  selection: AlertVisualSelection;
  preset: AlertVisualPreset;
  event: ChatEvent;
  motion: AlertVisualMotion;
}) {
  return (
    <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-caption text-text-dim">Selected alert preview</span>
        <span className="rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-micro text-text-muted">
          {EVENT_KIND_LABEL[kind]}
        </span>
      </div>
      <div
        className="overflow-hidden rounded-xl border border-border p-3"
        style={{
          background:
            "repeating-conic-gradient(#2a2f3a 0% 25%, #1c212b 0% 50%) 0 0 / 18px 18px",
        }}
      >
        <div
          key={`${kind}:${preset.id}:${motion}`}
          data-testid="alert-visual-preview"
          style={{
            minHeight: 250,
            display: "grid",
            placeItems: "center",
            padding: 10,
          }}
        >
          <ChatAlertCard
            event={event}
            preset={preset}
            motion={motion}
            preview
          />
        </div>
      </div>
      <div className="mt-2 rounded-lg border border-border bg-bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg" aria-hidden>{preset.emoji}</span>
          <span className="text-body font-semibold text-text">{preset.label}</span>
          <span className="rounded-full bg-bg-elevated px-2 py-0.5 text-micro text-text-muted">
            {preset.category}
          </span>
        </div>
        <p className="mt-1 text-caption leading-relaxed text-text-dim">
          {preset.description}
        </p>
        {selection === "shuffle" ? (
          <p className="mt-2 text-micro text-accent-cyan">
            Smart Shuffle preview · the real choice changes deterministically
            for each {EVENT_KIND_LABEL[kind].toLowerCase()}.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
