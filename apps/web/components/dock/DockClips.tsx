"use client";

import { DockCopyText } from "./DockCopyText";
import { Circle, Flag, Flame, Play } from "lucide-react";
import { DockInput, DockButton } from "./DockControls";

/**
 * DockClips — the clip-moment log for the Stream Dock: every moment
 * the engagement service flagged (chat spikes, notable game events),
 * newest first, with the chat lines that caused it — a ready-made
 * highlight shortlist for post-stream editing.
 *
 * The VOD toolkit turns the log from a list of wall-clock times into
 * a content workflow:
 *   * "Mark stream start" pins the go-live moment (also auto-set when
 *     Go live clears a Starting Soon scene) — every moment then ALSO
 *     shows its offset into the stream ("2:12:10 in").
 *   * Pasting the VOD URL makes each moment a clickable link that
 *     opens the VOD at that second (Twitch ``?t=2h12m10s``, YouTube
 *     ``?t=7930s``; other https URLs link plain).
 *   * "Copy timestamps" copies the whole list as ``H:MM:SS — reason``
 *     lines — paste into YouTube chapters or an editor's marker list.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { ClipMoment } from "@/lib/multichat/useEngagementState";
import { formatOffset, toYouTubeChapters, vodLinkAt } from "@/lib/vodLinks";
import { csvFilename, downloadCsv } from "@/lib/csvExport";
import { MOMENT_KIND_LABELS, clipMomentsCsv, clipTimestampText, momentKey } from "@/lib/multichat/clipLog";
import { useDockClipLog } from "./useDockClipLog";

import type { DockPost } from "./dockActions";
import { DockActionNotice, DockSnapshotState, useDockPanelActions } from "./useDockPanelActions";

export { formatOffset, vodLinkAt } from "@/lib/vodLinks";

export function DockClips({
  token = "",
  loadHistory = true,
  moments,
  markUndo,
  streamStartMs,
  vodUrl,
  busy,
  studioReady = true,
  onPost,
}: {
  token?: string;
  loadHistory?: boolean;
  moments: ReadonlyArray<ClipMoment>;
  markUndo?: ReactNode;
  streamStartMs: number | null;
  vodUrl: string | null;
  busy: boolean;
  studioReady?: boolean;
  onPost: DockPost;
}) {
  const [vodDraft, setVodDraft] = useState("");
  const log = useDockClipLog(token, studioReady && loadHistory, moments);
  const { run, notice, pending } = useDockPanelActions(studioReady, busy, onPost, {
    saveVod: () => vodDraft.trim() ? { patch: { vodUrl: vodDraft.trim() }, message: "VOD link saved", after: () => setVodDraft("") } : null,
    clearVod: () => ({ patch: { vodUrl: null }, message: "VOD link cleared" }),
    mark: () => ({ patch: { streamStartMs: Date.now() }, message: "Stream start marked" }),
    clearMark: () => ({ patch: { streamStartMs: null }, message: "Stream start cleared" }),
  });
  if (!studioReady) return <DockSnapshotState />;

  return (
    <fieldset disabled={busy || pending} className="min-w-0"><div className="space-y-2.5">
      <DockActionNotice message={notice} />
      <div className="flex flex-wrap items-center gap-2">
        {streamStartMs ? (
          <>
            <span className="text-micro text-text-muted">
              Stream start marked{" "}
              <b className="tabular-nums text-text">
                {new Date(streamStartMs).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </b>
            </span>
            <DockButton
              disabled={busy}
              onClick={() => void run("clearMark")}
            >
              Clear mark
            </DockButton>
          </>
        ) : (
          <>
            <DockButton
              disabled={busy}
              onClick={() => void run("mark")}
            >
              <Circle aria-hidden className="h-4 w-4" /> Mark stream start
            </DockButton>
            <span className="text-micro text-text-dim">
              …or it auto-marks when you tap Go live on Starting Soon.
            </span>
          </>
        )}
        {markUndo}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {vodUrl ? (
          <>
            <span className="max-w-[16rem] truncate text-micro text-text-muted">
              VOD: <span className="text-text">{vodUrl}</span>
            </span>
            <DockButton
              disabled={busy}
              onClick={() => void run("clearVod")}
            >
              Clear
            </DockButton>
          </>
        ) : (
          <>
            <DockInput
              type="url"
              value={vodDraft}
              onChange={(e) => setVodDraft(e.target.value)}
              placeholder="Paste VOD URL after stream → clickable timestamps"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-caption text-text placeholder:text-text-dim"
            />
            <DockButton
              disabled={busy || vodDraft.trim().length === 0}
              onClick={() => void run("saveVod")}
            >
              Save
            </DockButton>
          </>
        )}
      </div>

      {token ? <FlagMoment log={log} /> : null}
      <ClipLog log={log} streamStartMs={streamStartMs} vodUrl={vodUrl} />
    </div></fieldset>
  );
}

function FlagMoment({ log }: { log: ReturnType<typeof useDockClipLog> }) {
  const [note, setNote] = useState("");
  return <form className="space-y-1" onSubmit={(event) => {
    event.preventDefault();
    void log.flag(note).then((saved) => { if (saved) setNote(""); });
  }}>
    <div className="flex flex-wrap items-center gap-2">
      <DockInput aria-label="Moment note (optional)" placeholder="Moment note (optional)" maxLength={80}
        value={note} onChange={(event) => setNote(event.target.value)} className="min-w-0 flex-1" />
      <DockButton type="submit" disabled={log.flagging}><Flag aria-hidden className="h-4 w-4" /> Flag moment</DockButton>
    </div>
    {log.flagError ? <p role="alert" className="text-caption text-danger">{log.flagError}</p> : null}
  </form>;
}

function ClipLog({ log, streamStartMs, vodUrl }: { log: ReturnType<typeof useDockClipLog>; streamStartMs: number | null; vodUrl: string | null }) {
  const [filter, setFilter] = useState<ClipMoment["kind"] | "all">("all");
  const available = Object.keys(MOMENT_KIND_LABELS).filter((kind) => log.moments.some((moment) => moment.kind === kind)) as Array<ClipMoment["kind"]>;
  const selected = filter !== "all" && available.includes(filter) ? filter : "all";
  const visible = selected === "all" ? log.moments : log.moments.filter((moment) => moment.kind === selected);
  return <div className="space-y-2">
    {available.length ? <div role="group" aria-label="Moment kind" className="flex flex-wrap gap-1">
      {(["all", ...available] as const).map((kind) => <DockButton key={kind} type="button" aria-pressed={kind === selected} onClick={() => setFilter(kind)}>
        {kind === "all" ? "All" : MOMENT_KIND_LABELS[kind]}
      </DockButton>)}
    </div> : null}
    <ClipExports moments={visible} streamStartMs={streamStartMs} />
    {log.error ? <p role="alert" className="text-caption text-danger">{log.error} <DockButton onClick={() => void log.retry()}>Retry</DockButton></p> : null}
    {log.loading ? <p role="status" className="text-caption text-text-muted">Loading clip moments…</p> : null}
    {visible.length ? <ul className="space-y-1.5">{visible.map((moment) => <MomentRow key={momentKey(moment)} moment={moment} streamStartMs={streamStartMs} vodUrl={vodUrl} />)}</ul>
      : !log.loading && !log.error ? <p className="text-caption text-text-dim">No clip moments yet.</p> : null}
    {log.hasMore ? <DockButton disabled={log.loading} onClick={() => void log.loadOlder()}>Show older</DockButton> : null}
  </div>;
}

function ClipExports({ moments, streamStartMs }: { moments: ReadonlyArray<ClipMoment>; streamStartMs: number | null }) {
  if (!moments.length) return null;
  const chapters = toYouTubeChapters(moments, streamStartMs);
  const note = streamStartMs === null ? "Mark stream start first" : chapters.length < 3 ? "YouTube needs at least 3 chapters" : "";
  const timestamps = clipTimestampText(moments, streamStartMs);
  return <div className="space-y-1">
    <div className="flex flex-wrap gap-2">
      <DockCopyText value={timestamps} label="Copy timestamps" disabled={!timestamps} />
      <DockCopyText value={chapters.join("\n")} label="Copy YouTube chapters" disabled={Boolean(note)} />
      <DockButton onClick={() => downloadCsv(csvFilename("clip-moments"), clipMomentsCsv(moments, streamStartMs))}>Download CSV</DockButton>
    </div>
    {note ? <p className="text-micro text-text-muted">{note}</p> : null}
  </div>;
}

function MomentRow({
  moment: m,
  streamStartMs,
  vodUrl,
}: {
  moment: ClipMoment;
  streamStartMs: number | null;
  vodUrl: string | null;
}) {
  const offsetMs =
    streamStartMs && m.atMs >= streamStartMs ? m.atMs - streamStartMs : null;
  const link = useMemo(
    () => (offsetMs !== null && vodUrl ? vodLinkAt(vodUrl, offsetMs) : null),
    [offsetMs, vodUrl],
  );
  const offsetLabel = offsetMs !== null ? `${formatOffset(offsetMs)} in` : null;
  return (
    <li className="rounded-md border border-border bg-bg-elevated px-2.5 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-micro tabular-nums text-text-muted">
          {new Date(m.atMs).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
        {offsetLabel ? (
          link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-micro font-semibold tabular-nums text-accent-cyan underline decoration-accent-cyan/50 underline-offset-2 hover:text-accent-hover"
            >
              <Play aria-hidden className="inline h-3 w-3" /> {offsetLabel}
            </a>
          ) : (
            <span className="text-micro font-semibold tabular-nums text-text">
              {offsetLabel}
            </span>
          )
        ) : null}
        <span
          className={`text-micro font-bold uppercase tracking-wider ${
            m.kind === "game-event" ? "text-accent-cyan" : "text-warning"
          }`}
        >
          {m.kind === "chat-spike" ? <Flame aria-hidden className="mr-1 inline h-3 w-3" /> : null}{MOMENT_KIND_LABELS[m.kind]}
        </span>
      </div>
      <div className="mt-0.5 break-words text-caption text-text">
        {m.reason}
      </div>
      {m.sampleLines.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {m.sampleLines.map((l, i) => (
            <div key={i} className="truncate text-micro text-text-dim">
              {l}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}
