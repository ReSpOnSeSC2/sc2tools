"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ExternalLink, Link2, Twitch, Youtube } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import {
  CHANNEL_SOURCE_LABELS, channelUrl, channelValidation, channelWrite,
  directoryError, entryMatchesIdentity, identityLabel,
  type MyPlayerChannelsResponse, type PlayerChannelEntry,
} from "@/lib/playerChannelDirectory";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { useDirtyForm } from "@/components/ui/useDirtyForm";

const EMPTY_CHANNELS = { twitch: "", youtube: "" };

export function SettingsPlayerChannels({
  savedPulseIds, profileDirty, onDirtyChange,
}: {
  savedPulseIds: string[];
  profileDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { getToken } = useAuth();
  const { data, error, isLoading, mutate } = useApi<MyPlayerChannelsResponse>("/v1/me/player-channels");
  const [selection, setSelection] = useState("all");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<PlayerChannelEntry | null>(null);
  const profileKey = savedPulseIds.join(",");
  const previousProfile = useRef(profileKey);

  useEffect(() => {
    if (previousProfile.current === profileKey) return;
    previousProfile.current = profileKey;
    void mutate();
  }, [profileKey, mutate]);

  const identities = useMemo(() => data?.identities ?? [], [data?.identities]);
  const selectedIdentities = useMemo(() => selection === "all"
    ? identities
    : identities.filter((identity) => identityLabel(identity) === selection), [identities, selection]);
  const entries = useMemo(() => (data?.entries ?? []).filter((entry) =>
    selectedIdentities.some((identity) => entryMatchesIdentity(entry, identity))), [data?.entries, selectedIdentities]);
  const protectedEntries = entries.filter((entry) => !entry.editable);
  const visibleEntries = (data?.entries ?? []).filter((entry) => !entry.removed && (entry.editable || entries.includes(entry)));
  const mixed = entries.some((entry) =>
    (entry.channels.twitch || "") !== (entries[0]?.channels.twitch || "") ||
    (entry.channels.youtube || "") !== (entries[0]?.channels.youtube || ""));
  const serverChannels = useMemo(() => {
    if (!data) return undefined;
    if (mixed) return EMPTY_CHANNELS;
    const entry = entries.find((item) => !item.removed);
    return { twitch: entry?.channels.twitch || "", youtube: entry?.channels.youtube || "" };
  }, [data, entries, mixed]);
  const { draft, setDraft, dirty, reset, markSaved } = useDirtyForm(serverChannels, EMPTY_CHANNELS);
  const multipleRecords = entries.length > 1;
  const canEdit = Boolean(data?.canConnect && selectedIdentities.length && !protectedEntries.length && !multipleRecords);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function save() {
    if (saving || !canEdit || !dirty) return;
    const validation = channelValidation(draft);
    if (validation) { setSaveError(validation); return; }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const response = await apiCall<MyPlayerChannelsResponse>(getToken, "/v1/me/player-channels", {
        method: "PUT",
        body: JSON.stringify({ identities: selectedIdentities.map(({ pulseCharacterId, toonHandle }) => ({ pulseCharacterId, toonHandle })), channels: channelWrite(draft) }),
      });
      await mutate(response, { revalidate: false });
      markSaved();
      setNotice(draft.twitch.trim() || draft.youtube.trim()
        ? "Channels submitted for admin review. Once approved, everyone can find them alongside your player identity."
        : "Your connected channels have been removed.");
    } catch (err) {
      setSaveError(directoryError(err));
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (saving || !disconnectTarget) return;
    setSaving(true); setSaveError(null); setNotice(null);
    try {
      const response = await apiCall<MyPlayerChannelsResponse>(getToken, "/v1/me/player-channels", {
        method: "PUT",
        body: JSON.stringify({ id: disconnectTarget.id, channels: { twitch: null, youtube: null } }),
      });
      await mutate(response, { revalidate: false });
      setDisconnectTarget(null);
      setNotice("Your connected channels have been removed.");
    } catch (err) {
      setSaveError(directoryError(err));
    } finally { setSaving(false); }
  }

  return (
    <Section title="Twitch & YouTube" description="Connect your channels to your StarCraft II identities. After admin review, everyone can find them at the top of your opponent profile. Replays show a recording link only when a matching recording and timestamp are available.">
      {isLoading ? <Skeleton rows={2} /> : error ? (
        <Card>
          <p role="alert" className="text-body text-danger">Couldn&apos;t load your channels. {error.message}</p>
          <Button className="mt-3" variant="secondary" onClick={() => void mutate()}>Retry</Button>
        </Card>
      ) : (
        <Card>
          <div className="space-y-5">
            {profileDirty ? <p className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-muted">Save your profile changes first to use newly added Pulse IDs here.</p> : null}
            {visibleEntries.length ? <ul className="space-y-2" aria-label="Connected channels">
              {visibleEntries.map((entry) => <li key={entry.id} className="rounded-lg border border-border bg-bg-elevated/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-caption font-semibold">{entry.displayName || "Connected player"}</span><Badge size="sm">{CHANNEL_SOURCE_LABELS[entry.source]}</Badge>{entry.pending ? <Badge size="sm" variant="warning">Pending review</Badge> : null}</div>
                  {entry.editable ? <Button variant="ghost" size="sm" disabled={saving || dirty} aria-label={`Disconnect ${entry.displayName || "player"}`} onClick={() => { setSaveError(null); setDisconnectTarget(entry); }}>Disconnect</Button> : null}
                </div>
                <p className="mt-1 break-all font-mono text-micro text-text-dim">{[...entry.toonHandles, ...entry.pulseCharacterIds.map((id) => `Pulse ${id}`)].join(" · ")}</p>
                <div className="mt-2 flex flex-wrap gap-3">
                  {entry.pending ? <span className="self-center text-caption text-text-dim">Submitted:</span> : null}
                  {(["twitch", "youtube"] as const).map((platform) => {
                    const href = channelUrl(entry.channels[platform], platform);
                    return href ? <a key={platform} href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1.5 break-all text-caption text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{platform === "twitch" ? "Twitch" : "YouTube"}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a> : null;
                  })}
                </div>
                {entry.pending ? <div className="mt-2 text-caption text-text-muted">{entry.approvedChannels?.twitch || entry.approvedChannels?.youtube ? <><p>Your approved links remain public during review:</p><div className="mt-1 flex flex-wrap gap-3">{(["twitch", "youtube"] as const).map((platform) => {
                  const href = channelUrl(entry.approvedChannels?.[platform], platform);
                  return href ? <a key={platform} href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 text-accent hover:underline">{platform === "twitch" ? "Twitch" : "YouTube"}<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a> : null;
                })}</div></> : "These channels will appear publicly once an administrator approves them."}</div> : null}
              </li>)}
            </ul> : null}
            {!identities.length ? (
              <div className="flex items-start gap-3 py-2">
                <Link2 className="mt-0.5 h-5 w-5 flex-none text-accent" aria-hidden />
                <div>
                  <p className="font-semibold">Add your StarCraft II identity first</p>
                  <p className="mt-1 text-body text-text-muted">Add a Pulse ID or toon handle above and save your profile. Then connect the channels you want other players to see.</p>
                </div>
              </div>
            ) : (
              <>
                <Field label="Connect channels for" hint={dirty ? "Save or discard your channel changes before switching identities." : "Use all identities to share the same channels across regions and accounts."}>
                  <Select value={selection} disabled={saving || dirty} onChange={(event) => { setSelection(event.target.value); setSaveError(null); setNotice(null); }}>
                    <option value="all">All saved identities ({identities.length})</option>
                    {identities.map((identity) => <option key={identityLabel(identity)} value={identityLabel(identity)}>{identityLabel(identity)}</option>)}
                  </Select>
                </Field>
                {protectedEntries.length ? (
                  <p className="rounded-lg border border-border bg-bg-elevated/40 p-3 text-body text-text-muted">These channels are managed by an administrator or another connected account. Contact an administrator to correct them, or select another identity.</p>
                ) : multipleRecords ? (
                  <p className="text-body text-text-muted">These identities have separate channel records. Select one identity above to edit its channels.</p>
                ) : !data?.canConnect ? (
                  <p className="text-body text-text-muted">Your saved identities could not be resolved yet. Check your Pulse IDs and try again.</p>
                ) : (
                  <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                    {mixed ? <p className="text-caption text-text-muted">Your identities currently have different channels. Choose one identity to edit it, or enter channels below to update every selected identity.</p> : null}
                    <fieldset disabled={saving} className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                      <Field label={<span className="inline-flex items-center gap-1.5"><Twitch className="h-4 w-4" aria-hidden />Twitch channel URL</span>} hint="Use your channel page. Leave blank to remove your Twitch link.">
                        <Input type="url" autoComplete="url" value={draft.twitch} placeholder="https://www.twitch.tv/yourname" onChange={(event) => { setDraft((current) => ({ ...current, twitch: event.target.value })); setSaveError(null); setNotice(null); }} />
                      </Field>
                      <Field label={<span className="inline-flex items-center gap-1.5"><Youtube className="h-4 w-4" aria-hidden />YouTube channel URL</span>} hint="Use a channel or @handle URL. Leave blank to remove your YouTube link.">
                        <Input type="url" autoComplete="url" value={draft.youtube} placeholder="https://www.youtube.com/@yourname" onChange={(event) => { setDraft((current) => ({ ...current, youtube: event.target.value })); setSaveError(null); setNotice(null); }} />
                      </Field>
                    </fieldset>
                    <p className="text-caption text-text-muted">Only connect channels that belong to you. An administrator reviews new links and edits before publishing them. Changes apply to every identity on this channel record. Clear both fields to disconnect immediately.</p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" loading={saving && !disconnectTarget} disabled={!dirty || !canEdit || saving}>Save channels</Button>
                      {dirty ? <Button variant="ghost" disabled={saving} onClick={() => { reset(); setSaveError(null); }}>Discard changes</Button> : null}
                    </div>
                  </form>
                )}
              </>
            )}
            {saveError && !disconnectTarget ? <p role="alert" className="text-body text-danger">{saveError}</p> : null}
            {notice ? <p role="status" className="text-body text-success">{notice}</p> : null}
          </div>
        </Card>
      )}
      <ConfirmDialog open={Boolean(disconnectTarget)} onClose={() => { if (!saving) setDisconnectTarget(null); }} onConfirm={() => void disconnect()} title="Disconnect your channels?" description="This removes your Twitch and YouTube links from every identity on this channel record for all users." confirmLabel="Disconnect channels" loading={saving}>
        <p className="text-body text-text-muted">You can connect your channels again from this profile.</p>
        {saveError ? <p role="alert" className="mt-3 text-danger">{saveError}</p> : null}
      </ConfirmDialog>
    </Section>
  );
}
