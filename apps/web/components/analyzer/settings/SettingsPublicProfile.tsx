"use client";
import { useAuth } from "@clerk/nextjs";
import { useId } from "react";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { PlayerCopyButton } from "@/components/public-profile/PlayerCopyButton";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { usePublicPlayerEditor, PLAYER_SECTION_FIELDS } from "./usePublicPlayerEditor";
import { PlayerPanelSettings } from "./PlayerPanelSettings";

const labels = { showReplays: "Link my shared replays", showChannels: "Show approved channels", showRecentForm: "Show recent results and last played", showMmrHistory: "Show weekly MMR over 90 days", showSeasons: "Show season records", showMaps: "Show map records with at least 10 games" };

export function SettingsPublicProfile() {
  const auth = useAuth();
  if (!auth.isLoaded) return <Skeleton rows={2} />;
  if (!auth.isSignedIn || !auth.userId) return null;
  return <OwnedPublicProfile key={auth.userId} />;
}

function OwnedPublicProfile() {
  const visibilityDescription = useId();
  const editor = usePublicPlayerEditor();
  const { baseline, draft, busy, slug } = editor;
  const published = Boolean(baseline?.enabled || baseline?.legacyPublic);
  const cooldown = Boolean(baseline?.renameAvailableAt && Date.parse(baseline.renameAvailableAt) > Date.now());
  return <Section id="public-profile" className="scroll-mt-28" title="Public player page" description="Choose whether anyone can see your record and the sections you share.">
    {editor.request.error && !baseline ? <RequestError error={editor.request.error} onRetry={() => editor.reload()} /> : !baseline || !draft ? <Skeleton rows={3} /> : <Card padded>
      <form className="min-w-0 space-y-5" onSubmit={event => { event.preventDefault(); void editor.save(); }}>
        <p className="text-caption text-text-muted">Your profile and replay archive have separate switches. Turning this profile off also removes profile links from shared replays. <LazyHelpLink slug="public-profile">Help</LazyHelpLink></p>
        {baseline.legacyPublic ? <p className="rounded-lg border border-border p-3 text-caption">A named Community build made your legacy profile public. Saving these controls replaces that legacy choice; Off will hide your profile even while those builds remain published.</p> : null}
        {!baseline.slug ? <div className="space-y-3"><p className="text-caption text-text-muted">Create a player link first. This assigns an address while keeping your profile and optional sections off.</p><Button loading={busy} onClick={() => void editor.save(true)}>Create player link</Button></div> : <>
          <label className="flex min-h-11 items-center gap-3 font-semibold"><input type="checkbox" aria-describedby={visibilityDescription} checked={draft.enabled} disabled={busy} onChange={event => editor.setDraft({ ...draft, enabled: event.target.checked })} />Public profile on</label>
          <p id={visibilityDescription} className="text-caption text-text-muted">When on, visitors see the name <strong className="text-text">{baseline.publicDisplayName || "your saved display name"}</strong> with your public record.</p>
          <Field label="Player link prefix" hint={baseline.replaySharingEnabled ? "Turn off replay sharing explicitly before changing this shared address." : cooldown ? `This link can change after ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(baseline.renameAvailableAt!))}.` : "Lowercase letters, numbers and hyphens. The fixed suffix keeps your address unique; renames have a 30-day cooldown."}
            error={!editor.validPrefix ? "Use lowercase letters, numbers and single hyphens." : editor.changedSlug && editor.availability.data?.slug === slug && !editor.availability.data.available ? "That prefix is unavailable or reserved." : undefined}>
            <Input value={editor.prefix} maxLength={53} disabled={busy || baseline.replaySharingEnabled || cooldown} onChange={event => editor.setPrefix(event.target.value.toLowerCase())} />
          </Field>
          <p className="break-all font-mono text-caption text-text-muted">sc2tools.com/players/{slug}</p>
          {editor.changedSlug ? <p role="status" className="text-caption text-text-muted">{editor.availability.error ? "Couldn't check this link. Try again." : editor.available ? "This link is available." : "Checking link availability…"}</p> : null}
          {editor.availability.error ? <Button variant="secondary" size="sm" onClick={() => void editor.availability.mutate()}>Check link again</Button> : null}
          <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 font-semibold">Optional public sections</legend>{PLAYER_SECTION_FIELDS.map(key => <label key={key} className="flex min-h-11 items-center gap-3 text-caption"><input type="checkbox" checked={draft[key]} onChange={event => editor.setDraft({ ...draft, [key]: event.target.checked })} />{labels[key]}</label>)}</fieldset>
          <p className="text-caption text-text-muted">The replay link appears only if you separately enable replay sharing. Renaming changes the profile link; old renamed links are not aliases.</p>
          <div className="flex flex-wrap gap-2"><Button type="submit" loading={busy} disabled={!editor.validPrefix || !editor.available}>Save public profile</Button><Button variant="ghost" disabled={busy} onClick={() => void editor.reload()}>Refresh saved settings</Button>
            {published ? <><LinkButton href={`/players/${encodeURIComponent(baseline.slug)}`} variant="secondary">Preview profile</LinkButton><PlayerCopyButton path={`/players/${encodeURIComponent(baseline.slug)}`} label="Copy profile link" /></> : null}</div>
          <PlayerPanelSettings slug={baseline.slug} enabled={published} />
        </>}
        {editor.feedback ? <p role={editor.feedback.error ? "alert" : "status"} className={`text-caption ${editor.feedback.error ? "text-danger" : "text-success"}`}>{editor.feedback.text}</p> : null}
      </form>
    </Card>}
  </Section>;
}
