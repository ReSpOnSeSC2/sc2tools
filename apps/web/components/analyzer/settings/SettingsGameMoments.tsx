"use client";
import { useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { GameMomentCard } from "@/components/overlay/widgets/GameMomentCard";
import { GAME_MOMENT_KINDS, GAME_MOMENT_LABELS, gameMomentIdentity, sanitizeGameMomentConfig, type GameMoment, type GameMomentChoice, type GameMomentConfig, type GameMomentKind } from "@/lib/gameMoments";
import { resolveAlertVisualPreset, type AlertVisualMotion, type AlertVisualPreset, type AlertVisualSelection } from "@/lib/multichat/alerts";
import { DEFAULT_SOUND, previewSound, type ChatSoundConfig } from "@/lib/multichat/sound";
import { SOUND_EFFECTS } from "@/lib/multichat/soundEffects";
import { PACK_SOUNDS } from "@/lib/multichat/soundPack";
import { API_BASE } from "@/lib/clientApi";
import { previewableSound } from "./SettingsMultiChatSounds";

function MomentSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <Button role="switch" aria-label={label} aria-checked={checked} variant="secondary" fullWidth className="min-h-11 justify-between gap-3 text-left" onClick={() => onChange(!checked)}>
    <span className="min-w-0 break-words">{label}</span><span aria-hidden className="shrink-0">{checked ? "On" : "Off"}</span>
  </Button>;
}
/** A controlled addition to the existing multichat dirty draft/Save flow.
 * Local Test changes no preference and sends no message or overlay command. */
export function SettingsGameMoments({ value, onChange, presets, motion, sound = DEFAULT_SOUND, overlayToken = null }: {
  value?: GameMomentConfig; onChange: (next: GameMomentConfig) => void; presets: readonly AlertVisualPreset[];
  motion: AlertVisualMotion; sound?: ChatSoundConfig; overlayToken?: string | null;
}) {
  const id = useId(), nonce = useRef(0), config = useMemo(() => sanitizeGameMomentConfig(value), [value]);
  const [preview, setPreview] = useState<GameMoment | null>(null);
  const allowed = useMemo(() => new Set(presets.map(preset => preset.id)), [presets]);
  const change = (patch: Partial<GameMomentConfig>) => onChange({ ...config, ...patch });
  const choiceFor = (kind: GameMomentKind) => { const choice = config.moments[kind]; return choice.preset === "shuffle" || allowed.has(choice.preset) ? choice : { ...choice, preset: "classic" as const }; };
  const patchChoice = (kind: GameMomentKind, patch: Partial<GameMomentChoice>) => change({ moments: { ...config.moments, [kind]: { ...choiceFor(kind), ...patch } } });
  function test(kind: GameMomentKind) {
    nonce.current++; setPreview({ kind, headline: GAME_MOMENT_LABELS[kind], detail: "Sample only. No replay statistics are changed.", gameId: `local-preview:${nonce.current}`, atMs: Date.now(), isTest: true });
    previewSound(choiceFor(kind).sound, sound.eventVolume, previewableSound(sound, overlayToken), API_BASE);
  }
  const enabled = Object.values(config.moments).filter(choice => choice.enabled).length;
  return <details className="rounded-lg border border-border bg-bg-surface p-3">
    <summary className="min-h-11 cursor-pointer text-body font-semibold text-text">Game moments <span className="ml-2 text-caption font-normal text-text-muted">Ladder · {enabled} of 9 on</span></summary>
    <div className="mt-3 space-y-4">
      <p className="text-caption text-text-muted">Celebrate newly recorded 1v1 achievements. Supporter alerts play first. Tests preview this browser only; use Save to apply choices.</p>
      <LazyHelpLink slug="game-moment-alerts" className="inline-flex min-h-11 items-center !text-text underline">How game moments work</LazyHelpLink>
      <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-caption text-text" htmlFor={`${id}-step`}>MMR milestone spacing<Select id={`${id}-step`} className="min-h-11" value={config.mmrStep} onChange={event => change({ mmrStep: Number(event.target.value) as 100 | 250 })}><option value={100}>Every 100 recorded MMR</option><option value={250}>Every 250 recorded MMR</option></Select></label>
        <MomentSwitch label="Post moments through the configured Twitch bot" checked={config.botPost} onChange={botPost => change({ botPost })} /></div>
      <p className="text-caption text-text-muted">Moment sounds follow Event alert sounds and volume below. Bot posts use your already connected bot. MMR marks use replay game-start ratings; missing evidence is skipped.</p>
      <div className="grid gap-3 xl:grid-cols-2">{GAME_MOMENT_KINDS.map(kind => { const choice = choiceFor(kind), label = GAME_MOMENT_LABELS[kind]; return <fieldset key={kind} className="min-w-0 space-y-2 rounded border border-border p-3"><legend className="sr-only">{label}</legend>
        <MomentSwitch label={label} checked={choice.enabled} onChange={enabled => patchChoice(kind, { enabled })} />
        <label htmlFor={`${id}-${kind}-preset`} className="block text-caption">Visual for {label}<Select id={`${id}-${kind}-preset`} className="mt-1 min-h-11" value={choice.preset} onChange={event => patchChoice(kind, { preset: event.target.value as AlertVisualSelection })}><option value="shuffle">Smart Shuffle</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.category} · {preset.label}</option>)}</Select></label>
        <label htmlFor={`${id}-${kind}-sound`} className="block text-caption">Sound for {label}<Select id={`${id}-${kind}-sound`} className="mt-1 min-h-11" value={choice.sound} onChange={event => patchChoice(kind, { sound: event.target.value })}><option value="none">None</option><optgroup label="Synthesized">{SOUND_EFFECTS.map(effect => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</optgroup><optgroup label="Bundled recordings">{PACK_SOUNDS.map(effect => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</optgroup>{sound.customSounds.length ? <optgroup label="Your sounds">{sound.customSounds.map(effect => <option key={effect.id} value={effect.id}>{effect.label}</option>)}</optgroup> : null}</Select></label>
        <Button variant="secondary" className="min-h-11" onClick={() => test(kind)} aria-label={`Test ${label}`}>Test locally</Button>
      </fieldset>; })}</div>
      {preview ? <section aria-label="Game moment preview" className="min-w-0 space-y-2 rounded border border-border p-3"><p role="status" className="text-caption font-semibold">TEST · Local preview</p><GameMomentCard key={gameMomentIdentity(preview)} moment={preview} preset={resolveAlertVisualPreset(choiceFor(preview.kind).preset, "reward", gameMomentIdentity(preview))} motion={motion} preview /></section> : null}
    </div>
  </details>;
}
