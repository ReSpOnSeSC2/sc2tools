"use client";

import { formatDateTime } from "@/lib/i18n/format";
import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { useConfirm } from "@/components/ui/useConfirm";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { DiscordEmbedPreview, type DiscordPreview } from "./DiscordEmbedPreview";

type Events = { result: boolean; session: boolean; weekly: boolean; milestone: boolean; ladderMilestone?: boolean };
type Options = { mmr: boolean; replayLink: boolean };
export type DiscordHook = { id: string; label: string; last4: string; events: Events; options: Options; enabled: boolean; status: "active" | "disabled";
  disabledReason: string | null; failureCount: number; previewed: boolean; lastPostAt: string | null; lastResult: string | null; createdAt: string };
type DiscordState = { available: boolean; maxHooks: number; hooks: DiscordHook[]; privateEmbeds?: boolean };

const EVENT_LABELS: ReadonlyArray<readonly [keyof Events, string]> = [
  ["result", "Each ranked result"], ["session", "Session summaries"], ["weekly", "Weekly recap"],
  ["milestone", "MMR peaks and promotions"], ["ladderMilestone", "Ladder milestones from your inbox"],
];
const RESULT_TEXT: Record<string, string> = { sent: "Test posted to Discord.", webhook_gone: "Discord says this webhook no longer exists. Paste a new one.", rate_limited: "Discord is rate limiting this webhook. Try again in a minute.", failed: "Discord didn't accept the test. Try again later." };

/** Settings > Integrations: post results, sessions and milestones to the user's own Discord channel webhooks. */
export function DiscordSettings() {
  const { userId } = useAuth();
  return userId ? <DiscordSettingsPanel key={userId} /> : null;
}

function DiscordSettingsPanel() {
  const { getToken } = useAuth();
  const state = useApi<DiscordState>("/v1/me/integrations/discord");
  const [failure, setFailure] = useState<{ error: ClientApiError; retry: () => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const call = <T,>(path: string, init: RequestInit) => apiCall<T>(getToken, path, init);
  async function run(work: () => Promise<unknown>) {
    if (busy) return false;
    setBusy(true);
    setFailure(null);
    try { await work(); await state.mutate(); return true; }
    catch (cause) { setFailure({ error: cause as ClientApiError, retry: work }); return false; }
    finally { setBusy(false); }
  }
  const data = state.data;
  return <Section id="discord" className="scroll-mt-28" title="Post to Discord" description="Send your results, session summaries, weekly recap, MMR peaks and promotions to a channel in your Discord server. Nothing is posted until you turn a channel on.">
    {state.error && !data ? <RequestError error={state.error} onRetry={() => state.mutate()} /> : !data ? <Skeleton rows={4} /> : <div className="space-y-4">
      {failure ? <RequestError error={failure.error} onRetry={() => run(failure.retry)} /> : null}
      {!data.available ? <Card><p className="text-caption text-text-muted">Posting to Discord isn&apos;t available on this server yet.</p></Card> : <>
        {data.hooks.map((hook) => <HookCard key={hook.id} hook={hook} busy={busy} run={run} call={call}
          privateEmbeds={data.privateEmbeds === true} />)}
        {data.hooks.length < data.maxHooks ? <ConnectForm busy={busy} onConnect={(url, label) => run(() => call("/v1/me/integrations/discord/hooks", { method: "POST", body: JSON.stringify({ url, label }) }))} />
          : <p className="text-caption text-text-muted">You have connected the maximum of {data.maxHooks} channels.</p>}
      </>}
      <p className="text-caption text-text-muted">Create a webhook in Discord under Server Settings, Integrations, Webhooks, then Copy Webhook URL. <LazyHelpLink slug="discord">Post your games to Discord</LazyHelpLink></p>
    </div>}
  </Section>;
}

function ConnectForm({ busy, onConnect }: { busy: boolean; onConnect: (url: string, label: string) => Promise<boolean> }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim()) return;
    // The URL leaves the page once; it is never kept after a successful connect.
    if (await onConnect(url.trim(), label.trim())) { setUrl(""); setLabel(""); }
  }
  return <Card><form onSubmit={submit} className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:items-end">
    <Field label="Webhook URL" hint="Starts with https://discord.com/api/webhooks/">
      <Input type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/…" required />
    </Field>
    <Field label="Name (optional)" hint="Shown only to you">
      <Input value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} placeholder="Clan chat" />
    </Field>
    <Button type="submit" className="min-h-11" disabled={busy || !url.trim()}>Connect channel</Button>
  </form></Card>;
}

type Run = (work: () => Promise<unknown>) => Promise<boolean>;
type Call = <T>(path: string, init: RequestInit) => Promise<T>;

function HookCard({ hook, busy, run, call, privateEmbeds }: { hook: DiscordHook; busy: boolean; run: Run; call: Call; privateEmbeds: boolean }) {
  const [previews, setPreviews] = useState<DiscordPreview[] | null>(null);
  const [note, setNote] = useState("");
  const { confirm, dialog } = useConfirm(hook.id);
  const remove = async () => {
    if (await confirm({ title: `Remove ${hook.label}?`, description: "SC2 Tools stops posting there and forgets this webhook. You can paste it again later.", confirmLabel: "Remove channel", intent: "danger" })) await run(() => call(base, { method: "DELETE" }));
  };
  const base = `/v1/me/integrations/discord/hooks/${encodeURIComponent(hook.id)}`;
  const patch = (body: { events?: Partial<Events>; options?: Partial<Options>; enabled?: boolean; shareMmr?: boolean }) => run(async () => {
    await call(base, { method: "PATCH", body: JSON.stringify(body) });
    setPreviews(null);
  });
  const preview = () => run(async () => { const res = await call<{ previews: DiscordPreview[] }>(`${base}/preview`, { method: "POST", body: "{}" }); setPreviews(res.previews); });
  const test = () => run(async () => { const res = await call<{ result: string }>(`${base}/test`, { method: "POST", body: "{}" }); setNote(RESULT_TEXT[res.result] || RESULT_TEXT.failed); });
  const status = hook.status === "disabled" ? <Badge variant="danger">Turned off: Discord rejected the webhook</Badge> : hook.enabled ? <Badge variant="success">On</Badge> : <Badge variant="neutral">Off</Badge>;
  return <Card>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="break-words text-body font-semibold text-text">{hook.label}</h3><p className="text-caption text-text-muted">Webhook ending in …{hook.last4}{hook.lastPostAt ? ` · last post ${formatDateTime(new Date(hook.lastPostAt))}` : ""}</p></div>
      <div className="flex items-center gap-3">{status}<Toggle checked={hook.enabled} disabled={busy || (!hook.enabled && (!hook.previewed || !privateEmbeds))} onChange={(enabled) => void patch({ enabled })} label={`Post to ${hook.label}`} /></div>
    </div>
    {!hook.previewed ? <p className="mt-2 text-caption text-text-muted">Preview the posts below before turning this channel on.</p> : null}
    {privateEmbeds ? <HookChoices hook={hook} busy={busy} patch={patch} /> :
      <p className="mt-2 text-caption text-text-muted">Discord posting options will be available after the server update.</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" className="min-h-11" disabled={busy || !privateEmbeds} onClick={() => void preview()}>Preview posts</Button>
      <Button variant="secondary" size="sm" className="min-h-11" disabled={busy || !privateEmbeds} onClick={() => void test()}>Send test</Button>
      <Button variant="secondary" size="sm" className="min-h-11" disabled={busy} onClick={() => void remove()}>Remove</Button>
    </div>
    {dialog}
    {note ? <p role="status" className="mt-2 text-caption text-text-muted">{note}</p> : null}
    {privateEmbeds && previews ? <div className="mt-3 grid gap-3 lg:grid-cols-2">{previews.map((row) => <DiscordEmbedPreview key={row.kind} preview={row} />)}</div> : null}
  </Card>;
}

type HookPatch = (body: { events?: Partial<Events>; options?: Partial<Options>; shareMmr?: boolean }) => Promise<boolean>;

function HookChoices({ hook, busy, patch }: { hook: DiscordHook; busy: boolean; patch: HookPatch }) {
  return <>
    <fieldset className="mt-3" disabled={busy}><legend className="text-caption font-semibold text-text">What to post</legend>
      <div className="mt-1 grid gap-1 sm:grid-cols-2">{EVENT_LABELS.map(([key, label]) => <label key={key} className="flex min-h-11 items-center gap-2 text-caption">
        <input type="checkbox" checked={hook.events[key] === true} onChange={(e) => void patch({ events: { [key]: e.target.checked } })} />{label}</label>)}</div>
    </fieldset>
    <fieldset className="mt-3" disabled={busy}><legend className="text-caption font-semibold text-text">Privacy</legend>
      <p className="mt-1 text-caption text-text-muted">Posts identify opponents by race when known.</p>
      <label className="flex min-h-11 items-start gap-2 py-1 text-caption">
        <input type="checkbox" className="mt-0.5" checked={hook.options.mmr} onChange={(e) => void patch({ shareMmr: e.target.checked })} />
        <span className="font-semibold text-text">Share my MMR<span className="block font-normal text-text-muted">Include your recorded ladder rating. Off until you choose it for this channel.</span></span>
      </label>
      <label className="flex min-h-11 items-start gap-2 py-1 text-caption">
        <input type="checkbox" className="mt-0.5" checked={hook.options.replayLink} onChange={(e) => void patch({ options: { replayLink: e.target.checked } })} />
        <span className="font-semibold text-text">Allow shared report links<span className="block font-normal text-text-muted">Post a link manually from a public battle report.</span></span>
      </label>
    </fieldset>
  </>;
}
