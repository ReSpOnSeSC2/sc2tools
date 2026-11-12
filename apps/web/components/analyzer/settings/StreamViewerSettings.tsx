"use client";

import { useEffect, useRef, useState } from "react";
import { Button, LinkButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { RequestError } from "@/components/ui/RequestError";
import { PlayerCopyButton } from "@/components/public-profile/PlayerCopyButton";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useApi } from "@/lib/clientApi";
import { STREAM_VIEWER_MAX_DELAY, STREAM_VIEWER_MIN_DELAY, validStreamViewerDelay, type StreamViewerSettings as Settings } from "@/lib/streamViewer";

const ENDPOINT = "/v1/me/stream-viewer";
type Draft = { enabled: boolean; tokenId: string; delay: string; revision: number };

function validDraft(draft: Draft, saved: Settings, delay: number) {
  return validStreamViewerDelay(delay)
    && (!draft.enabled || (saved.eligible && saved.sources.some(source => source.id === draft.tokenId)));
}

export function StreamViewerSettings({ handle, publicProfileEnabled }: { handle: string | null; publicProfileEnabled: boolean }) {
  const [opened, setOpened] = useState(false);
  if (!handle) return null;
  return <details className="mt-5 rounded-xl border border-border p-4" onToggle={event => {
    if (event.currentTarget.open) setOpened(true);
  }}>
    <summary className="min-h-11 cursor-pointer rounded-sm py-2 font-semibold text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      Stream viewer page
    </summary>
    <p className="mt-2 text-caption text-text-muted">Share delayed results from one Browser Source's Dock session. The page shows the opponent's race and known ladder map, with no player names. <LazyHelpLink slug="stream-viewer-page">Help</LazyHelpLink></p>
    {opened ? publicProfileEnabled ? <ViewerEditor key={handle} /> : <p className="mt-3 text-caption text-text-muted">Turn on and save your public player page to enable sharing.</p> : null}
  </details>;
}

function ViewerEditor() {
  const request = useApi<Settings>(ENDPOINT, { keepPreviousData: false, revalidateOnMount: true, revalidateOnFocus: false }, { timeoutMs: 10_000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  if (request.error) return <div className="mt-3"><RequestError error={request.error} onRetry={() => void request.mutate()} /></div>;
  if (request.isValidating || !request.data) return <div className="mt-3"><Skeleton rows={3} /></div>;
  const saved = request.data;
  const current = draft ?? { enabled: saved.tokenId !== null, tokenId: saved.tokenId ?? "", delay: String(saved.delayMinutes), revision: saved.revision };
  const delayMinutes = Number(current.delay);
  const tokenId = current.enabled ? current.tokenId : null;
  const valid = validDraft(current, saved, delayMinutes);
  const dirty = tokenId !== saved.tokenId || delayMinutes !== saved.delayMinutes;

  async function save() {
    if (pending.current || !valid || !dirty) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setFeedback(null);
    try {
      const next = await request.request<Settings>({ method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenId, delayMinutes, revision: current.revision }), signal: controller.signal });
      if (controller.signal.aborted) return;
      void request.mutate(next, false);
      setDraft(null);
      setFeedback({ error: false, message: next.href ? "Viewer page is shared." : "Viewer page is off." });
    } catch {
      if (!controller.signal.aborted) setFeedback({ error: true, message: "Couldn't save the viewer page. Try again or refresh saved settings." });
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <ViewerFields {...{ saved, current, valid, dirty, busy, feedback }} onChange={setDraft} onSave={save}
    onRefresh={() => { setDraft(null); setFeedback(null); void request.mutate(); }} />;
}

function ViewerFields({ saved, current, valid, dirty, busy, feedback, onChange, onSave, onRefresh }: {
  saved: Settings; current: Draft; valid: boolean; dirty: boolean; busy: boolean;
  feedback: { message: string; error: boolean } | null;
  onChange: (draft: Draft) => void; onSave: () => Promise<void>; onRefresh: () => void;
}) {
  return <form className="mt-3 min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void onSave(); }}>
    <label className="flex min-h-11 items-center gap-3 font-semibold">
      <input type="checkbox" checked={current.enabled} disabled={busy || !saved.eligible || !saved.sources.length}
        onChange={event => onChange({ ...current, enabled: event.target.checked, tokenId: current.tokenId || saved.sources[0].id })} />
      Share my stream viewer page
    </label>
    {!saved.sources.length ? <p className="text-caption text-text-muted">Set up a Browser Source in Settings → Overlay first.</p> : null}
    {current.enabled ? <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <Field label="Browser Source" hint="Start a new session in this source's Dock to publish results.">
          <Select value={current.tokenId} disabled={busy} onChange={event => onChange({ ...current, tokenId: event.target.value })}>
            {saved.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
          </Select>
        </Field>
        <Field label="Results delay (minutes)" hint="Choose 5 to 60 minutes. Match or exceed the delay on your broadcast.">
          <Input type="number" min={STREAM_VIEWER_MIN_DELAY} max={STREAM_VIEWER_MAX_DELAY} step={1}
            value={current.delay} disabled={busy} onChange={event => onChange({ ...current, delay: event.target.value })} />
        </Field>
      </div>
    </> : null}
    <ViewerActions href={saved.href} busy={busy} canSave={valid && dirty} onRefresh={feedback?.error ? onRefresh : undefined} />
    {feedback ? <p role={feedback.error ? "alert" : "status"} className="text-caption text-success [&[role=alert]]:text-danger">{feedback.message}</p> : null}
  </form>;
}

function ViewerActions({ href, busy, canSave, onRefresh }: { href: string | null; busy: boolean; canSave: boolean; onRefresh?: () => void }) {
  return <div className="flex flex-wrap gap-2">
    <Button type="submit" loading={busy} disabled={!canSave}>Save viewer page</Button>
    {onRefresh ? <Button variant="ghost" disabled={busy} onClick={onRefresh}>Refresh saved settings</Button> : null}
    {href ? <><LinkButton href={href} variant="secondary" prefetch={false}>Open viewer page</LinkButton>
      <PlayerCopyButton path={href} label="Copy viewer link" /></> : null}
  </div>;
}
