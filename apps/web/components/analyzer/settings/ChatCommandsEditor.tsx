"use client";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, boundedApiRequest } from "@/lib/clientApi";
import { CHAT_COMMAND_CATALOG as catalog, newCustomCommand, nightbotSnippet, type ChatCommandPreferences, type CommandOptions, type CustomCommand } from "@/lib/multichat/chatCommandPreferences";
import { useChatCommandSettings } from "@/lib/multichat/useChatCommandSettings";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";

export function ChatCommandsEditor({ token, onSaved }: { token: string; onSaved: (preferences: ChatCommandPreferences | null) => void }) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p role="status" className="text-caption text-text-muted">Loading command settings…</p>;
  if (!isSignedIn || !userId) return <p role="status" className="text-caption text-text-muted">Sign in to edit commands.</p>;
  return <EditorBody key={`${userId}:${token}`} token={token} onSaved={onSaved} />;
}

function EditorBody({ token, onSaved }: { token: string; onSaved: (preferences: ChatCommandPreferences | null) => void }) {
  const settings = useChatCommandSettings(token);
  const [argument, setArgument] = useState(""), [user, setUser] = useState("viewer"), [platform, setPlatform] = useState("twitch"), [onStream, setOnStream] = useState(false);
  const [copy, setCopy] = useState({ busy: false, trigger: "", fallback: "", copied: false });
  const mounted = useRef(true), activeCopy = useRef<AbortController | null>(null), fallback = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; activeCopy.current?.abort(); }; }, []);
  useEffect(() => { onSaved(settings.saved); }, [settings.saved, onSaved]);
  useEffect(() => { if (copy.fallback) { fallback.current?.focus(); fallback.current?.select(); } }, [copy.fallback]);
  if (settings.readError) return <div role="alert" className="space-y-2 text-caption text-warning"><p>Couldn’t load your saved commands. Retry before editing.</p><Button size="sm" className="min-h-11" variant="secondary" onClick={settings.retry}>Retry command settings</Button></div>;
  if (!settings.ready || !settings.draft) return <p role="status" className="text-caption text-text-muted">Loading saved commands…</p>;
  const draft = settings.draft, busy = !!settings.busy || copy.busy;
  const change = (kind: "builtins" | "custom", index: number, patch: Partial<CommandOptions & { response: string }>) => {
    settings.setDraft({ ...draft, [kind]: draft[kind].map((row, position) => position === index ? { ...row, ...patch } : row) });
    setCopy({ busy: false, trigger: "", fallback: "", copied: false });
  };
  const copySnippet = async (trigger: string) => {
    if (settings.dirty || activeCopy.current) return;
    const controller = new AbortController(), text = nightbotSnippet(API_BASE, token, trigger); activeCopy.current = controller;
    setCopy({ busy: true, trigger, fallback: "", copied: false });
    try {
      await boundedApiRequest(() => navigator.clipboard.writeText(text), 10_000, controller.signal);
      if (mounted.current && activeCopy.current === controller && !controller.signal.aborted) setCopy({ busy: false, trigger, fallback: "", copied: true });
    } catch {
      if (mounted.current && activeCopy.current === controller && !controller.signal.aborted) setCopy({ busy: false, trigger, fallback: text, copied: false });
    } finally { if (activeCopy.current === controller) activeCopy.current = null; }
  };
  return <section aria-label="Edit chat commands" className="space-y-4 border-t border-border pt-4">
    <div><h3 className="text-body font-semibold">Chat command settings</h3><p className="mt-1 text-caption text-text-muted">Changes stay in this draft until Save. Try it uses saved settings and shows the exact reply without posting to chat. Save changes before trying or copying updated commands.</p></div>
    <fieldset disabled={busy} className="flex min-w-0 flex-wrap gap-3 rounded-lg border border-border p-3"><legend className="text-caption font-semibold">Preview context</legend>
      <label className="min-w-40 flex-1 text-caption">Argument<Input className="mt-1 min-h-11" aria-label="Command argument" maxLength={80} value={argument} onChange={event => setArgument(event.target.value)} placeholder="For example, PvZ or Zerg" /></label>
      <label className="min-w-32 flex-1 text-caption">Viewer<Input className="mt-1 min-h-11" aria-label="Preview viewer" maxLength={80} value={user} onChange={event => setUser(event.target.value)} /></label>
      <label className="text-caption">Platform<Select className="mt-1 min-h-11" aria-label="Preview platform" value={platform} onChange={event => setPlatform(event.target.value)}>{catalog.platforms.map(value => <option key={value}>{value}</option>)}</Select></label>
      <label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" checked={onStream} onChange={event => setOnStream(event.target.checked)} />Preview on-stream answer</label>
    </fieldset>
    <fieldset disabled={busy} className="min-w-0 space-y-4">
      <legend className="sr-only">Saved and custom commands</legend>
      <div role="table" aria-label="Chat command settings" aria-colcount={4} className="min-w-0 space-y-3">
        <div role="row" className="hidden gap-3 text-caption font-semibold lg:grid lg:grid-cols-4">{["Command", "Alias and cooldown", "Where it answers", "Preview and copy"].map(name => <div key={name} role="columnheader">{name}</div>)}</div>
        {draft.builtins.map((row, index) => { const definition = catalog.commands.find(command => command.id === row.id)!; return <CommandRow key={row.id} row={row} label={`!${row.id}`} description={definition.description} aliases={definition.aliases} changed={patch => change("builtins", index, patch)} dirty={settings.dirty} trying={settings.busy === row.trigger} onTry={() => void settings.tryCommand(row.trigger, argument, user, platform, onStream)} onCopy={() => void copySnippet(row.trigger)} />; })}
        {draft.custom.map((row, index) => <CommandRow key={index} row={row} label={`Custom command ${index + 1}`} changed={patch => change("custom", index, patch)} dirty={settings.dirty} trying={settings.busy === row.trigger} onTry={() => void settings.tryCommand(row.trigger, argument, user, platform, onStream)} onCopy={() => void copySnippet(row.trigger)} onRemove={() => settings.setDraft({ ...draft, custom: draft.custom.filter((_, position) => position !== index) })} />)}
      </div>
      <Button variant="secondary" className="min-h-11" disabled={draft.custom.length >= catalog.maxCustom} onClick={() => settings.setDraft({ ...draft, custom: [...draft.custom, newCustomCommand()] })}>Add custom command</Button>
      <p className="text-caption text-text-muted">{draft.custom.length} of {catalog.maxCustom} custom commands. Variables: {catalog.variables.map(value => `{${value}}`).join(" · ")}. Replies are one plain-text line, up to 1,000 characters; outgoing replies are limited to 380 characters.</p>
    </fieldset>
    {settings.preview ? <div role="status" aria-live="polite" className="space-y-1 rounded-lg border border-border p-3 text-caption"><p className="font-semibold">Saved preview · !{settings.preview.trigger}</p><output className="block break-words">{settings.preview.text ?? ({ disabled: "This command is disabled for the selected context.", unknown: "No saved command matches this name.", cooldown: "This command is cooling down.", reply: "No reply is available from the recorded data." })[settings.preview.status]}</output></div> : null}
    {copy.copied ? <p role="status" className="text-caption text-success">Nightbot snippet copied for !{copy.trigger}.</p> : null}
    {copy.fallback ? <label className="block space-y-1 text-caption text-text-muted">Copy this Nightbot snippet<input ref={fallback} readOnly value={copy.fallback} onFocus={event => event.currentTarget.select()} className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-bg-surface p-2 text-caption" /></label> : null}
    {settings.error ? <p role="alert" className="text-caption text-warning">{settings.error}</p> : null}
    <div className="flex flex-wrap items-center gap-3"><Button className="min-h-11" disabled={!settings.dirty || busy} loading={settings.busy === "save"} onClick={() => void settings.save()}>Save chat commands</Button><span role="status" className="text-caption text-text-muted">{settings.dirty ? "Unsaved changes" : "Saved settings"}</span></div>
    <p className="text-caption text-text-muted">Copy a Nightbot snippet into its command response field. The snippet contains your overlay token; keep it in that command configuration. Saving here does not connect a platform or send a message.</p>
  </section>;
}

function CommandRow({ row, label, description, aliases = [], changed, dirty, trying, onTry, onCopy, onRemove }: {
  row: CommandOptions & Partial<CustomCommand>; label: string; description?: string; aliases?: string[];
  changed: (patch: Partial<CommandOptions & { response: string }>) => void; dirty: boolean; trying: boolean; onTry: () => void; onCopy: () => void; onRemove?: () => void;
}) {
  return <div role="row" className="grid min-w-0 gap-3 rounded-lg border border-border p-3 lg:grid-cols-4">
    <div role="rowheader" className="min-w-0 space-y-2"><h4 className="break-words text-body font-semibold">{label}</h4>{description ? <p className="text-caption text-text-muted">{description}</p> : null}{aliases.length ? <p className="text-micro text-text-muted">Also {aliases.map(alias => `!${alias}`).join(", ")}. Default names remain available.</p> : null}<label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" aria-label={`Enable ${label}`} checked={row.enabled} onChange={event => changed({ enabled: event.target.checked })} />Enabled</label>{row.response !== undefined ? <label className="block text-caption">Reply<textarea aria-label={`Reply for ${label}`} rows={3} maxLength={1000} value={row.response} onChange={event => changed({ response: event.target.value })} className="mt-1 w-full min-w-0 rounded-lg border border-border bg-bg-surface p-2 text-caption" /></label> : null}</div>
    <div role="cell" className="min-w-0 space-y-2"><label className="block text-caption">Alias<Input aria-label={`Alias for ${label}`} className="mt-1 min-h-11" value={row.trigger} maxLength={24} onChange={event => changed({ trigger: event.target.value })} /></label><label className="block text-caption">Cooldown · seconds<Input aria-label={`Cooldown for ${label}`} className="mt-1 min-h-11" type="number" min={5} max={3600} step={1} value={row.cooldownSec} onChange={event => changed({ cooldownSec: Number(event.target.value) })} /></label></div>
    <div role="cell" className="min-w-0"><details><summary className="min-h-11 cursor-pointer py-3 text-caption">Platforms ({row.platforms.length})</summary>{catalog.platforms.map(platform => <label key={platform} className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" aria-label={`${platform} for ${label}`} checked={row.platforms.includes(platform)} onChange={event => changed({ platforms: event.target.checked ? [...row.platforms, platform] : row.platforms.filter(value => value !== platform) })} />{platform}</label>)}</details><label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" aria-label={`On-stream answers for ${label}`} checked={row.answerOnStream} onChange={event => changed({ answerOnStream: event.target.checked })} />On-stream answers</label></div>
    <div role="cell" className="flex min-w-0 flex-wrap items-start gap-2 lg:flex-col"><Button size="sm" className="min-h-11" variant="secondary" disabled={dirty} loading={trying} aria-label={`Try it · ${label}`} onClick={onTry}>Try it</Button><Button size="sm" className="min-h-11" variant="ghost" disabled={dirty} aria-label={`Copy Nightbot · ${label}`} onClick={onCopy}>Copy Nightbot</Button>{onRemove ? <Button size="sm" className="min-h-11" variant="ghost" aria-label={`Remove ${label}`} onClick={onRemove}>Remove</Button> : null}</div>
  </div>;
}
