"use client";

import { useCallback, useId, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ExternalLink, Pencil, Trash2, Twitch, Youtube } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { CHANNEL_SOURCE_LABELS, channelUrl, channelValidation, channelWrite, directoryError, type PlayerChannelEntry, type PlayerChannelWrite } from "@/lib/playerChannelDirectory";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";

export function PlayerChannelRow({ entry, busy, onEdit, onRemove }: {
  entry: PlayerChannelEntry; busy: boolean; onEdit: () => void; onRemove: () => void;
}) {
  const identities = [...entry.toonHandles, ...entry.pulseCharacterIds.map((identity) => `Pulse ${identity}`), ...(entry.proId ? [`SC2Pulse pro ${entry.proId}`] : [])];
  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-h3 font-bold">{entry.displayName || "Unnamed player"}</h2>
            <Badge size="sm" variant={entry.source === "self" ? "accent" : "neutral"}>{CHANNEL_SOURCE_LABELS[entry.source]}</Badge>
            {entry.pending ? <Badge size="sm" variant="warning">Pending review</Badge> : null}
            {entry.removed ? <Badge size="sm" variant="danger">Removed</Badge> : null}
          </div>
          <div className="flex flex-wrap gap-2 text-micro text-text-muted" aria-label={`Identities for ${entry.displayName || "player"}`}>
            {identities.slice(0, 4).map((identity) => <span key={identity} className="max-w-full break-all rounded-md border border-border bg-bg-elevated/40 px-2 py-1 font-mono">{identity}</span>)}
          </div>
          {identities.length > 4 ? <details className="text-caption text-text-muted"><summary className="min-h-9 cursor-pointer py-1 font-medium">Show {identities.length - 4} more identities</summary><div className="mt-2 flex max-h-48 flex-wrap gap-2 overflow-y-auto rounded-lg border border-border p-2">{identities.slice(4).map((identity) => <span key={identity} className="max-w-full break-all rounded-md bg-bg-elevated/40 px-2 py-1 font-mono text-micro">{identity}</span>)}</div></details> : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {(["twitch", "youtube"] as const).map((platform) => {
              const href = channelUrl(entry.channels[platform], platform);
              const label = platform === "twitch" ? "Twitch" : "YouTube";
              const Icon = platform === "twitch" ? Twitch : Youtube;
              return href ? (
                <a key={platform} href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-caption text-accent hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`${entry.displayName || "Player"} on ${label}`}>
                  <Icon className="h-4 w-4 flex-none" aria-hidden /><span className="break-all">{href.replace("https://", "")}</span><ExternalLink className="h-3.5 w-3.5 flex-none" aria-hidden />
                </a>
              ) : <span key={platform} className="inline-flex min-h-11 items-center gap-2 px-1 text-caption text-text-dim"><Icon className="h-4 w-4" aria-hidden />No {label} link</span>;
            })}
          </div>
          {entry.pending ? <p className="text-caption text-text-muted">Player-submitted links awaiting review. Open the editor to verify the identities and approve them.</p> : null}
          <p className="text-micro text-text-dim">Updated {new Date(entry.updatedAt).toLocaleString()}</p>
        </div>
        <div className="flex flex-wrap gap-2 lg:flex-col lg:items-stretch">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onEdit} iconLeft={<Pencil className="h-3.5 w-3.5" aria-hidden />} aria-label={`${entry.removed ? "Edit or restore" : entry.pending ? "Review" : "Edit"} ${entry.displayName || "player"}`}>{entry.removed ? "Edit / restore" : entry.pending ? "Review" : "Edit"}</Button>
          {!entry.removed ? <Button variant="ghost" size="sm" disabled={busy} className="text-danger" iconLeft={<Trash2 className="h-3.5 w-3.5" aria-hidden />} aria-label={`Remove ${entry.displayName || "player"}`} onClick={onRemove}>Remove</Button> : null}
        </div>
      </div>
    </Card>
  );
}

function splitIdentities(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)));
}

export function PlayerChannelEditor({ entry, onClose, onSaved }: {
  entry: PlayerChannelEntry | null; onClose: () => void;
  onSaved: (entry: PlayerChannelEntry) => Promise<void>;
}) {
  const { getToken } = useAuth();
  const formId = useId();
  const [name, setName] = useState(entry?.displayName || "");
  const [pulseIds, setPulseIds] = useState(entry?.pulseCharacterIds.join("\n") || "");
  const [toonHandles, setToonHandles] = useState(entry?.toonHandles.join("\n") || "");
  const [proId, setProId] = useState(entry?.proId || "");
  const [channels, setChannels] = useState({ twitch: entry?.channels.twitch || "", youtube: entry?.channels.youtube || "" });
  const [restore, setRestore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const dirty = name !== (entry?.displayName || "") || pulseIds !== (entry?.pulseCharacterIds.join("\n") || "") || toonHandles !== (entry?.toonHandles.join("\n") || "") || proId !== (entry?.proId || "") || channels.twitch !== (entry?.channels.twitch || "") || channels.youtube !== (entry?.channels.youtube || "") || restore;
  const close = useCallback(() => {
    if (saving) return;
    if (dirty) setDiscarding(true);
    else onClose();
  }, [saving, dirty, onClose]);
  const textareaClass = "block w-full resize-y rounded-lg border-2 border-line bg-bg-surface px-3 py-2 font-mono text-caption text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50";

  async function save() {
    if (saving) return;
    const pulseCharacterIds = splitIdentities(pulseIds);
    const toons = splitIdentities(toonHandles);
    const invalidChannels = channelValidation(channels);
    if (!name.trim()) { setError("Enter a player name so this record is easy to find."); return; }
    if (!pulseCharacterIds.length && !toons.length && !proId.trim()) { setError("Add at least one Pulse ID or toon handle to identify this player."); return; }
    if (pulseCharacterIds.length > 100 || toons.length > 100) { setError("Use at most 100 Pulse IDs and 100 toon handles per player."); return; }
    if (pulseCharacterIds.some((identity) => !/^[1-9]\d{0,19}$/.test(identity))) { setError("Pulse IDs must be positive numbers. Put toon handles in the toon handles field."); return; }
    if (toons.some((identity) => !/^[1-9]\d?-S2-[1-9]\d?-\d{1,20}$/.test(identity))) { setError("Use complete toon handles, such as 1-S2-1-267727."); return; }
    if (proId.trim() && !/^[1-9]\d{0,19}$/.test(proId.trim())) { setError("The SC2Pulse pro ID must be a positive number."); return; }
    if (invalidChannels) { setError(invalidChannels); return; }
    if ((!entry || restore) && !channels.twitch.trim() && !channels.youtube.trim()) { setError("Add a Twitch or YouTube channel for this player."); return; }
    const body: PlayerChannelWrite = {
      displayName: name.trim(), pulseCharacterIds, toonHandles: toons,
      proId: proId.trim() || null, channels: channelWrite(channels),
      ...(entry ? { removed: entry.removed && !restore } : {}),
      ...(entry?.revision !== undefined ? { revision: entry.revision } : {}),
    };
    setSaving(true); setError(null);
    try {
      const response = await apiCall<{ entry: PlayerChannelEntry }>(getToken,
        entry ? `/v1/admin/player-channels/${encodeURIComponent(entry.id)}` : "/v1/admin/player-channels", {
          method: entry ? "PUT" : "POST", body: JSON.stringify(body),
        });
      await onSaved(response.entry);
    } catch (err) { setError(directoryError(err)); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={close} title={discarding ? "Discard your changes?" : entry ? `Edit ${entry.displayName || "player"}` : "Add player channels"} description={discarding ? "Your changes have not been saved." : "Changes apply to the shared directory for every user."} size="lg" disableScrimClose footer={discarding ? <><Button variant="secondary" onClick={() => setDiscarding(false)}>Keep editing</Button><Button variant="danger" onClick={onClose}>Discard changes</Button></> : <><Button variant="secondary" onClick={close} disabled={saving}>Cancel</Button><Button type="submit" form={formId} loading={saving}>{restore ? "Save and restore" : entry?.pending ? "Approve and save" : "Save player"}</Button></>}>
      {discarding ? <p className="text-body text-text-muted">Keep editing to finish linking this player&apos;s channels, or discard to leave the directory unchanged.</p> : <form id={formId} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          {entry?.pending ? <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-muted"><strong className="text-text">Review this player&apos;s submission</strong><p className="mt-1">Verify that these channels belong to the player identified below. Approve and save publishes the submitted links for everyone.</p></div> : null}
          <Field label="Player name" required hint="The public name people use to recognize this player."><Input required maxLength={80} autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <div className="rounded-lg border border-border bg-bg-elevated/30 p-3">
            <h3 className="text-caption font-semibold">StarCraft II identities</h3>
            <p className="mt-1 text-caption text-text-muted">Add every region or account belonging to this player. Separate multiple IDs with a comma or new line. A toon handle works without a SC2Pulse profile.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Pulse character IDs" hint="Numeric IDs from SC2Pulse player URLs."><textarea rows={3} className={textareaClass} value={pulseIds} placeholder="994428" spellCheck={false} onChange={(event) => setPulseIds(event.target.value)} /></Field>
              <Field label="Toon handles" hint="Stable identities from replays or opponent profiles."><textarea rows={3} className={textareaClass} value={toonHandles} placeholder="1-S2-1-267727" spellCheck={false} onChange={(event) => setToonHandles(event.target.value)} /></Field>
            </div>
            <details className="mt-4 text-caption text-text-muted">
              <summary className="cursor-pointer font-medium text-text">Advanced: SC2Pulse pro identity</summary>
              <Field className="mt-3" label="SC2Pulse pro ID" hint="Optional. Use only when the ID has been confirmed in SC2Pulse."><Input inputMode="numeric" value={proId} onChange={(event) => setProId(event.target.value)} /></Field>
            </details>
          </div>
          <Field label="Twitch channel URL" hint="Leave blank to remove this channel from the directory."><Input type="url" maxLength={300} value={channels.twitch} placeholder="https://www.twitch.tv/channel" onChange={(event) => setChannels((current) => ({ ...current, twitch: event.target.value }))} /></Field>
          <Field label="YouTube channel URL" hint="Use a channel or @handle URL, rather than a video or playlist."><Input type="url" maxLength={300} value={channels.youtube} placeholder="https://www.youtube.com/@channel" onChange={(event) => setChannels((current) => ({ ...current, youtube: event.target.value }))} /></Field>
          {entry?.source === "self" ? <p className="text-caption text-text-muted">The player keeps access to submit future changes for review. Automatic imports preserve approved links.</p> : entry && entry.source !== "admin" ? <p className="text-caption text-text-muted">Saving makes this an admin-managed record. Automatic imports will preserve your edits.</p> : null}
          {entry?.removed ? <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-body"><input type="checkbox" checked={restore} onChange={(event) => setRestore(event.target.checked)} className="mt-1 h-4 w-4 accent-accent" /><span><strong>Restore public channels</strong><span className="mt-1 block text-caption text-text-muted">Show these channels for everyone again after saving.</span></span></label> : null}
        </fieldset>
        {error ? <p role="alert" className="mt-4 text-body text-danger">{error}</p> : null}
      </form>}
    </Modal>
  );
}
