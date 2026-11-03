"use client";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useReplayPackDownload } from "@/lib/exports/replayPacks/useReplayPackDownload";
import type { PackNameTemplate } from "@/lib/exports/replayPacks/packNames";
import type { useReplayPackSelection } from "./useReplayPackSelection";

type Props = { selection: ReturnType<typeof useReplayPackSelection>; blocked: boolean; onClose: () => void };
const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

/** Lazy, explicit pack mode: Settings and the ordinary list do not load the ZIP controller. */
export default function ReplayPackControls({ selection, blocked, onClose }: Props) {
  const filenameId = useId();
  const [template, setTemplate] = useState<PackNameTemplate>("descriptive");
  const [started, setStarted] = useState<{ scope: string; cancelled: boolean } | null>(null);
  const scope = `${selection.scope}:${template}:${blocked ? "blocked" : "ready"}`;
  const download = useReplayPackDownload(scope);
  useEffect(() => { if (!download.busy && started) setStarted(null); }, [download.busy, started]);
  const ownJob = started?.scope === scope;
  const rows = [...selection.rows.values()], unknown = rows.filter(row => row.replaySizeBytes === null).length;
  const known = rows.reduce((sum, row) => sum + (row.replaySizeBytes || 0), 0), disabled = blocked || download.busy || selection.pending;
  return <section aria-label="Replay pack" className="mt-4 space-y-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Private replay pack</h3><LazyHelpLink slug="replay-packs">Replay pack help</LazyHelpLink></div>
    <p className="text-caption text-text-muted">Choose up to 100 games across pages with these filters. Pack selection is separate from managing this page. Select matching replaces your selection with the first 100 games in the current sort.</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={disabled} onClick={() => { void selection.matching(); }}>Select matching (up to 100)</Button>
      <Button variant="ghost" disabled={download.busy || !rows.length} onClick={selection.clear}>Clear pack selection</Button>
      {selection.pending ? <Button variant="secondary" onClick={selection.cancelMatching}>Cancel selection</Button> : null}
      <span className="text-caption" role="status">{rows.length} of 100 selected</span>
    </div>
    <label htmlFor={filenameId} className="block max-w-xl space-y-1 text-caption">Replay filename<Select id={filenameId} aria-label="Replay pack filename template" value={template} disabled={disabled} onChange={event => { download.clear(); setTemplate(event.target.value as PackNameTemplate); }}>
      <option value="descriptive">Date matchup result vs opponent on map</option><option value="date-opponent-map">Date, opponent, map</option><option value="date-matchup-map">Date, matchup, map</option><option value="game-id">Game ID</option>
    </Select></label>
    <p className="text-caption text-text-muted">Known original size: {mib(known)}{unknown ? `; ${unknown} size${unknown === 1 ? "" : "s"} unknown` : ""}. Archive size also includes its filenames and manifest. Availability is checked when downloading.</p>
    <p className="text-caption text-text-muted">Original .SC2Replay files can contain player and account identifiers, chat and team information. Keep the archive private and review it before sharing. Temporary file links already issued may work until their one-minute expiry.</p>
    <p className="text-caption text-text-muted">Save directly to a file when offered. Other browsers keep the completed archive in memory, up to 128 MiB; choose fewer games for a smaller download. A cancelled pack does not automatically save a partial archive.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={disabled || !rows.length} onClick={() => { setStarted({ scope, cancelled: false }); void download.run(rows, template); }}>Download replay pack</Button>
      {ownJob && download.busy ? <Button variant="secondary" disabled={started?.cancelled} onClick={() => { setStarted({ scope, cancelled: true }); download.cancel(); }}>{started?.cancelled ? "Stopping replay pack…" : "Cancel replay pack"}</Button> : null}
      <Button variant="ghost" disabled={download.busy || selection.pending} onClick={onClose}>Close replay pack</Button></div>
    {blocked ? <p role="status" className="text-caption text-text-muted">Wait for the current filters and replay list before selecting or downloading.</p> : null}
    {selection.message ? <p role="status" className="text-caption">{selection.message}</p> : null}
    {download.feedback ? <div role="status" aria-live="polite" className="space-y-1 text-caption"><p>{download.feedback.message}</p>
      {download.feedback.progress ? <p>{download.feedback.progress.completed} of {download.feedback.progress.total} files checked · {mib(download.feedback.progress.downloadedBytes)} downloaded · {mib(download.feedback.progress.archiveBytes)} written</p> : null}
      {download.feedback.result ? <p>{download.feedback.result.saved} original file{download.feedback.result.saved === 1 ? "" : "s"} saved; {download.feedback.result.failed} unavailable or failed. Archive: {mib(download.feedback.result.bytes)}. See manifest.csv for each game&apos;s result.</p> : null}
    </div> : null}
    {download.busy && !ownJob ? <p role="status" className="text-caption">An export is still finishing. Wait for its cleanup before starting another.</p> : null}
  </section>;
}
