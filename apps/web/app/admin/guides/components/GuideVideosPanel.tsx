"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, RefreshCw } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { fmtDate } from "@/lib/format";
import { guideDisplayName } from "@/lib/guides/slugs";
import type {
  GuideAdminNotesPayload,
  GuideAdminVideo,
  GuideAdminVideoResponse,
  GuideAdminVideosPayload,
  GuideVideoSyncResult,
} from "@/lib/guides/types";
import { parseYouTubeVideoId } from "@/lib/youtube";
import { GUIDE_LINK_CLASS } from "@/components/guides/guideUi";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { LoadingRows } from "../../components/AdminFragments";
import { GuideVideoOverridesCard } from "./GuideVideoOverrides";
import {
  AdminNotice,
  AdminSectionHeader,
  EIGHT_WORKER_BADGE,
  GUIDE_VIDEOS_PATH,
  GUIDE_VIDEOS_SYNC_PATH,
  adminErrorText,
  guideNoteKey,
  guideVideoApiPath,
  type AdminNoticeValue,
  type AdminResource,
  type GuideSelection,
} from "./guidesAdminShared";

const HEADING_ID = "guide-videos-heading";
const LIST_HEADING_ID = "guide-videos-list-heading";
const INVALID_URL_TEXT = "Paste a YouTube video link (youtube.com/watch?v=…, youtu.be/…, /shorts/…) or an 11-character video id.";
const SOURCE_LABEL: Readonly<Record<GuideAdminVideo["source"], string>> = {
  rss: "Channel feed",
  snapshot: "Channel snapshot",
  admin: "Added by an admin",
};

export interface GuideVideosPanelProps {
  videos: AdminResource<GuideAdminVideosPayload>;
  notes: AdminResource<GuideAdminNotesPayload>;
  selection: GuideSelection;
}

function useVideoActions(videos: AdminResource<GuideAdminVideosPayload>) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<AdminNoticeValue | null>(null);

  async function run<T>(kind: string, path: string, init: RequestInit, done: (result: T) => string, lead: string): Promise<boolean> {
    if (busy) return false;
    setBusy(kind);
    setNotice(null);
    try {
      const result = await apiCall<T>(getToken, path, init);
      await videos.mutate();
      setNotice({ tone: "success", text: done(result) });
      return true;
    } catch (err) {
      setNotice({ tone: "error", text: adminErrorText(lead, err) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return {
    busy,
    notice,
    sync: () => run<GuideVideoSyncResult>("sync", GUIDE_VIDEOS_SYNC_PATH, { method: "POST" }, (r) => `Channel synced: ${r.fetched} videos in the feed, ${r.inserted} new, ${r.updated} updated.`, "Couldn't sync the channel."),
    add: (youtubeId: string) => run<GuideAdminVideoResponse>("add", GUIDE_VIDEOS_PATH, { method: "POST", body: JSON.stringify({ youtubeId }) }, (r) => `Added “${r.item.title}”.`, "Couldn't add the video."),
    setHidden: (video: GuideAdminVideo, hidden: boolean) => run<GuideAdminVideoResponse>(video.youtubeId, guideVideoApiPath(video.youtubeId), { method: "PATCH", body: JSON.stringify({ hidden }) }, () => (hidden ? `“${video.title}” is hidden on every guide.` : `“${video.title}” can show on guides again.`), "Couldn't update the video."),
  };
}

/**
 * Build-order videos from the site owner's channel: what the API detected
 * for each (matchup, builds, counters), global hide/unhide, add an older
 * video by URL, "Sync now", and the selected guide's pin/hide choices.
 */
export function GuideVideosPanel({ videos, notes, selection }: GuideVideosPanelProps) {
  const actions = useVideoActions(videos);
  const items = videos.data?.items ?? [];
  return (
    <section aria-labelledby={HEADING_ID} className="space-y-4">
      <AdminSectionHeader
        id={HEADING_ID}
        title="Videos"
        description="The channel feed syncs every 6 hours. Guides show the author's own videos with their description text, verbatim."
        actions={
          <Button variant="secondary" iconLeft={<RefreshCw className="h-4 w-4" aria-hidden />} loading={actions.busy === "sync"} disabled={Boolean(actions.busy)} onClick={() => void actions.sync()}>
            Sync now
          </Button>
        }
      />
      <AdminNotice notice={actions.notice} />
      {videos.error ? (
        <Card><p role="alert" className="text-danger">Couldn&apos;t load channel videos. {videos.error.message}</p></Card>
      ) : !videos.data ? (
        <div role="status" aria-label="Loading channel videos"><LoadingRows rows={4} /></div>
      ) : (
        <>
          {/* Keyed by guide: switching builds clears the previous guide's notice. */}
          <GuideVideoOverridesCard key={guideNoteKey(selection.matchup, selection.buildKey)} videos={items} notes={notes} selection={selection} />
          <AddVideoForm busy={actions.busy === "add"} disabled={Boolean(actions.busy)} onAdd={actions.add} />
          <ChannelVideoList items={items} busy={actions.busy} onSetHidden={(video, hidden) => void actions.setHidden(video, hidden)} />
        </>
      )}
    </section>
  );
}

function AddVideoForm({ busy, disabled, onAdd }: { busy: boolean; disabled: boolean; onAdd: (youtubeId: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const youtubeId = parseYouTubeVideoId(value);
    if (!youtubeId) {
      setError(INVALID_URL_TEXT);
      return;
    }
    setError(null);
    if (await onAdd(youtubeId)) setValue("");
  }

  return (
    <Card>
      <form className="flex flex-col gap-3 sm:flex-row sm:items-start" onSubmit={(event) => void submit(event)} noValidate>
        <Field className="min-w-0 flex-1" label="Add a video by URL" hint="Only videos from the configured channel can be added; the title comes from YouTube." error={error}>
          <Input type="url" inputMode="url" value={value} placeholder="https://www.youtube.com/watch?v=…" spellCheck={false} onChange={(event) => { setValue(event.target.value); setError(null); }} />
        </Field>
        <Button type="submit" className="sm:mt-7" iconLeft={<Plus className="h-4 w-4" aria-hidden />} loading={busy} disabled={disabled || !value.trim()}>
          Add video
        </Button>
      </form>
    </Card>
  );
}

function detectedText(video: GuideAdminVideo): string {
  if (!video.matchup) return "No build-order match (Shorts, streams and untagged titles never match).";
  const builds = video.builds.map(guideDisplayName).join(", ") || "none";
  const counters = video.counters.map(guideDisplayName).join(", ") || "none";
  return `${video.matchup} · builds: ${builds} · counters: ${counters}`;
}

function ChannelVideoList({
  items,
  busy,
  onSetHidden,
}: {
  items: ReadonlyArray<GuideAdminVideo>;
  busy: string | null;
  onSetHidden: (video: GuideAdminVideo, hidden: boolean) => void;
}) {
  return (
    <Card>
      <h3 id={LIST_HEADING_ID} className="text-body font-semibold text-text">Channel videos ({items.length.toLocaleString()})</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-caption text-text-dim">No videos stored yet. Sync the channel or add one by URL.</p>
      ) : (
        <ul aria-labelledby={LIST_HEADING_ID} className="mt-2 divide-y divide-border">
          {items.map((video) => (
            <li key={video.youtubeId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <a href={video.url} target="_blank" rel="noopener noreferrer" className={`${GUIDE_LINK_CLASS} break-words text-body`}>{video.title}</a>
                <p className="text-caption text-text-muted">{detectedText(video)}</p>
                <div className="flex flex-wrap items-center gap-1.5 text-caption text-text-dim">
                  <span>{video.publishedAt ? fmtDate(video.publishedAt) : "Upload date pending the next feed sync"} · {SOURCE_LABEL[video.source]}</span>
                  {video.isShort ? <Badge size="sm">Short</Badge> : null}
                  {video.eightWorkerPatch ? <Badge size="sm">{EIGHT_WORKER_BADGE}</Badge> : null}
                  {video.hidden ? <Badge variant="danger" size="sm">Hidden everywhere</Badge> : null}
                </div>
              </div>
              <Button
                size="sm"
                variant={video.hidden ? "secondary" : "ghost"}
                className="shrink-0"
                aria-label={`${video.hidden ? "Unhide" : "Hide"} “${video.title}” ${video.hidden ? "on guides" : "on every guide"}`}
                loading={busy === video.youtubeId}
                disabled={Boolean(busy)}
                onClick={() => onSetHidden(video, !video.hidden)}
              >
                {video.hidden ? "Unhide" : "Hide"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
