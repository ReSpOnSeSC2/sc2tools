"use client";
import { useLayoutEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { DEFAULT_TWITCH_AUTOMATION, twitchReason, validTwitchTemplate, type TwitchAutomationPreferences } from "@/lib/twitchAutomation";
import { useTwitchAutomationSettings } from "./useTwitchAutomationSettings";

function Choice({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <Button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} variant="secondary" fullWidth className="min-h-11 justify-between gap-3 text-left" style={{ height: "auto", paddingBlock: 8 }}><span className="min-w-0 break-words">{label}</span><span aria-hidden className="shrink-0">{checked ? "On" : "Off"}</span></Button>;
}
export function SettingsTwitchAutomation() {
  const model = useTwitchAutomationSettings();
  if (!model.owner) return <p className="text-caption text-text-muted">Sign in to view Twitch automation settings.</p>;
  return <Editor key={model.owner} model={model} />;
}
function Editor({ model }: { model: ReturnType<typeof useTwitchAutomationSettings> }) {
  const id = useId(), { status, busy, error, message } = model;
  const [draft, setDraft] = useState<TwitchAutomationPreferences>(DEFAULT_TWITCH_AUTOMATION), [dirty, setDirty] = useState(false);
  // Settle server preferences before a newly enabled control can accept input.
  useLayoutEffect(() => { if (status && !dirty) setDraft(status.preferences); }, [status, dirty]);
  useLayoutEffect(() => { if (message === "Twitch automation preferences saved.") setDirty(false); }, [message]);
  const change = (patch: Partial<TwitchAutomationPreferences>) => { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); };
  const baseReady = status?.serverEnabled === true && status.eligible === true;
  const predictionReady = baseReady && status.predictionPermission, markerReady = baseReady && status.markerPermission;
  const valid = Number.isInteger(draft.windowSec) && draft.windowSec >= 30 && draft.windowSec <= 300 && validTwitchTemplate(draft.titleTemplate);
  const canSave = status && dirty && valid && (!draft.predictionsEnabled || predictionReady) && (!draft.markersEnabled || markerReady);
  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-surface p-3">
    <h3 id={`${id}-title`} className="text-body font-semibold">Twitch automation</h3>
    <p className="text-caption text-text-muted">Optional Twitch Channel Points Predictions and stream markers for affiliate or partner broadcasters. Both start off and use their own Save.</p>
    <p className="text-caption text-text-muted">{twitchReason("ranked_status_unavailable")}</p>
    {status?.reason ? <p role="status" className="rounded border border-border bg-bg-elevated p-3 text-caption">{twitchReason(status.reason)}</p> : null}
    {!status && !error ? <p role="status" className="text-caption">Checking Twitch status…</p> : null}
    <div className="flex flex-wrap gap-2"><Button variant="secondary" className="min-h-11" disabled={busy} onClick={() => void model.refresh()}>Refresh status</Button>
      <Button variant="secondary" className="min-h-11" disabled={busy || !status?.serverEnabled} onClick={() => void model.connect("predictions")}>{status?.predictionPermission ? "Reconnect Predictions" : "Connect Predictions"}</Button>
      <Button variant="secondary" className="min-h-11" disabled={busy || !status?.serverEnabled} onClick={() => void model.connect("streaming")}>{status?.markerPermission ? "Reconnect markers" : "Connect markers"}</Button></div>
    <p className="text-caption text-text-muted">Connecting requests permission in Twitch. It leaves both switches unchanged. Complete that window, then refresh this status.</p>
    <Choice label="Open a Prediction at the loading screen" checked={draft.predictionsEnabled} disabled={busy || !status || !draft.predictionsEnabled && !predictionReady} onChange={predictionsEnabled => change({ predictionsEnabled })} />
    <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label htmlFor={`${id}-window`} className="block min-w-0 space-y-1 text-caption"><span>Prediction window (30–300 seconds)</span><Input id={`${id}-window`} type="number" min={30} max={300} step={1} className="min-h-11" value={draft.windowSec} disabled={busy || !status} onChange={event => change({ windowSec: Number(event.target.value) })} /></label>
      <p className="self-center text-caption text-text-muted">Win / Loss · Ranked 1v1 only · Rematches within 10 minutes are skipped.</p></div>
    <label htmlFor={`${id}-title-template`} className="block min-w-0 space-y-1 text-caption"><span>Prediction title template</span><Input id={`${id}-title-template`} className="min-h-11" value={draft.titleTemplate} disabled={busy || !status} maxLength={140} onChange={event => change({ titleTemplate: event.target.value })} invalid={!validTwitchTemplate(draft.titleTemplate)} /></label>
    <p className="break-words text-caption text-text-muted">Variables: {"{me}, {opp}, {oppRace}, {oppMmr}"}. Twitch titles are shortened to 45 characters. Missing MMR appears as ?.</p>
    <Choice label="Add a stream marker at each game start" checked={draft.markersEnabled} disabled={busy || !status || !draft.markersEnabled && !markerReady} onChange={markersEnabled => change({ markersEnabled })} />
    <p className="text-caption text-text-muted">Markers require a live channel with VODs enabled. Description: vs Opp · PvZ · Map. Games under 60 seconds, no verified result within 20 minutes, or a confirmed Dock cancellation request a prediction refund.</p>
    {!valid ? <p role="alert" className="text-caption text-danger">Use a whole window from 30 to 300 and a plain title with the supported variables.</p> : null}
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}{message ? <p role="status" className="text-caption text-success">{message}</p> : null}
    <div className="flex flex-wrap items-center gap-3"><Button className="min-h-11" disabled={!canSave || busy} onClick={() => void model.save(draft)} loading={busy && dirty}>Save Twitch automation</Button><LazyHelpLink slug="viewer-engagement" anchor="twitch-predictions" className="inline-flex min-h-11 items-center underline">Twitch prediction setup</LazyHelpLink></div>
  </section>;
}
