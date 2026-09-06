"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Download, Link2, Plus, RefreshCw, Search } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { directoryError, type PlayerChannelDirectoryResponse, type PlayerChannelEntry } from "@/lib/playerChannelDirectory";
import { Button } from "@/components/ui/Button";
import { Card, Skeleton } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { ForbiddenCard } from "../components/AdminFragments";
import { PlayerChannelEditor, PlayerChannelRow } from "./PlayerChannelEditor";

const PAGE_SIZE = 25;
type ImportResult = { imported: number; updated: number; skipped: number; total: number };

export default function AdminPlayerChannelsPage() {
  const { getToken } = useAuth();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [editor, setEditor] = useState<PlayerChannelEntry | "new" | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PlayerChannelEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const path = `/v1/admin/player-channels?search=${encodeURIComponent(search)}&page=${page}&limit=${PAGE_SIZE}&includeRemoved=${includeRemoved}&pendingOnly=${pendingOnly}`;
  const { data, error, isLoading, mutate } = useApi<PlayerChannelDirectoryResponse>(path);

  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(0); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const closeEditor = useCallback(() => setEditor(null), []);
  const closeRemove = useCallback(() => { if (!busy) setRemoveTarget(null); }, [busy]);

  async function refreshAfterMutation(message: string) {
    setNotice(message);
    await mutate();
  }

  async function importPulse() {
    if (busy) return;
    setBusy("import"); setMutationError(null); setNotice(null);
    try {
      const result = await apiCall<ImportResult>(getToken, "/v1/admin/player-channels/import-pulse", { method: "POST" });
      await refreshAfterMutation(`SC2Pulse import complete: ${result.imported.toLocaleString()} added, ${result.updated.toLocaleString()} updated, ${result.skipped.toLocaleString()} skipped (${result.total.toLocaleString()} checked).`);
    } catch (err) {
      setMutationError(`Couldn't import SC2Pulse channels. ${directoryError(err)}`);
    } finally { setBusy(null); }
  }

  async function remove() {
    if (!removeTarget || busy) return;
    setBusy(removeTarget.id); setMutationError(null); setNotice(null);
    try {
      await apiCall(getToken, `/v1/admin/player-channels/${encodeURIComponent(removeTarget.id)}`, { method: "DELETE" });
      setRemoveTarget(null);
      await refreshAfterMutation(`Channels for ${removeTarget.displayName || "this player"} removed from public views.`);
      if (data?.entries.length === 1 && page > 0) setPage(page - 1);
    } catch (err) {
      setMutationError(`Couldn't remove this player. ${directoryError(err)}`);
    } finally { setBusy(null); }
  }

  if (error?.status === 403) return <ForbiddenCard />;
  const total = data?.total ?? 0;
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-2xl space-y-2">
          <h1 className="text-3xl font-bold">Player channels</h1>
          <p className="text-body text-text-muted">The shared Twitch and YouTube directory. Link a channel once and every user sees it at the top of that player&apos;s opponent profile. Replays show a recording link only when a matching recording and timestamp are available.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" iconLeft={<Download className="h-4 w-4" aria-hidden />} loading={busy === "import"} disabled={Boolean(busy) || Boolean(error) || isLoading} onClick={() => void importPulse()}>Import SC2Pulse</Button>
          <Button iconLeft={<Plus className="h-4 w-4" aria-hidden />} disabled={Boolean(busy) || Boolean(error) || isLoading} onClick={() => setEditor("new")}>Add player</Button>
        </div>
      </header>
      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <Field className="min-w-0 flex-1" label="Search players" hint="Search by player name, channel, Pulse ID, or toon handle.">
            <Input type="search" value={query} placeholder="Search the directory" onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-4 pb-1">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-caption text-text-muted">
              <input type="checkbox" checked={pendingOnly} onChange={(event) => { setPendingOnly(event.target.checked); setPage(0); }} className="h-4 w-4 accent-accent" />Pending review only
            </label>
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-caption text-text-muted">
              <input type="checkbox" checked={includeRemoved} onChange={(event) => { setIncludeRemoved(event.target.checked); setPage(0); }} className="h-4 w-4 accent-accent" />Include removed
            </label>
            <Button variant="ghost" size="sm" aria-label="Refresh player channels" disabled={Boolean(busy)} iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} onClick={() => void mutate()}>Refresh</Button>
          </div>
        </div>
        <p className="mt-4 border-t border-border pt-3 text-caption text-text-dim">Use a stable Pulse ID or toon handle to match the correct player. Players do not need a SC2 Tools account or a SC2Pulse profile.</p>
      </Card>
      {notice ? <p role="status" className="rounded-lg border border-success/30 bg-success/5 p-3 text-body text-success">{notice}</p> : null}
      {mutationError && !removeTarget ? <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-body text-danger">{mutationError}</p> : null}
      {error ? (
        <Card><p role="alert" className="text-danger">Couldn&apos;t load player channels. {error.message}</p><Button variant="secondary" className="mt-3" onClick={() => void mutate()}>Retry</Button></Card>
      ) : isLoading ? <div role="status" aria-label="Loading player channels"><Skeleton rows={4} /></div> : !data?.entries.length ? (
        <Card><div className="flex flex-col items-center gap-3 py-8 text-center">
          {search ? <Search className="h-8 w-8 text-text-dim" aria-hidden /> : <Link2 className="h-8 w-8 text-accent" aria-hidden />}
          <h2 className="text-h3 font-bold">{search ? "No players match your search" : pendingOnly ? "No channels awaiting review" : "No players in this view"}</h2>
          <p className="max-w-md text-body text-text-muted">{search ? "Try a player name, channel, or stable StarCraft II identity." : pendingOnly ? "New player submissions will appear here when they need approval." : "Import SC2Pulse channels or add a player with a Twitch or YouTube channel."}</p>
          {search ? <Button variant="secondary" onClick={() => { setQuery(""); setSearch(""); setPage(0); }}>Clear search</Button> : null}
        </div></Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-dim">
            <p role="status">{total.toLocaleString()} player{total === 1 ? "" : "s"}{pendingOnly ? " awaiting review" : " in the directory"}{search ? ` matching “${search}”` : ""}</p>
            <p>Showing {(page * PAGE_SIZE + 1).toLocaleString()}–{Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()}</p>
          </div>
          <ul className="space-y-4" aria-label="Player channel directory">
            {data.entries.map((entry) => <li key={entry.id}><PlayerChannelRow entry={entry} busy={Boolean(busy)} onEdit={() => setEditor(entry)} onRemove={() => { setMutationError(null); setRemoveTarget(entry); }} /></li>)}
          </ul>
          <nav aria-label="Player channel pages" className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</Button>
            <p className="text-caption text-text-muted">Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</p>
            <Button variant="secondary" size="sm" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage((value) => value + 1)}>Next</Button>
          </nav>
        </>
      )}
      {editor !== null ? <PlayerChannelEditor key={editor === "new" ? "new" : editor.id} entry={editor === "new" ? null : editor} onClose={closeEditor} onSaved={async (entry) => { closeEditor(); setMutationError(null); await refreshAfterMutation(`Channels for ${entry.displayName || "this player"} saved for everyone.`); }} /> : null}
      <ConfirmDialog open={Boolean(removeTarget)} onClose={closeRemove} onConfirm={() => void remove()} title={`Remove ${removeTarget?.displayName || "this player"}'s channels?`} description="This hides their channels for everyone. The record remains available under Include removed so you can restore it later." confirmLabel="Remove channels" intent="danger" loading={Boolean(busy)}>
        <p className="text-body text-text-muted">Future imports will keep this removal in place.</p>
        {mutationError ? <p role="alert" className="mt-3 text-danger">{mutationError}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
