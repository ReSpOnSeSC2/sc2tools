"use client";

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

import { useMemo, useState } from "react";
import type { ClipMoment } from "@/lib/multichat/useEngagementState";
import { formatOffset, vodLinkAt } from "@/lib/vodLinks";
import { DockButton } from "./DockClient";

export { formatOffset, vodLinkAt } from "@/lib/vodLinks";

export function DockClips({
  moments,
  streamStartMs,
  vodUrl,
  busy,
  onPost,
}: {
  moments: ReadonlyArray<ClipMoment>;
  streamStartMs: number | null;
  vodUrl: string | null;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [vodDraft, setVodDraft] = useState("");
  const [copied, setCopied] = useState(false);

  const copyList = () => {
    const lines = [...moments]
      .sort((a, b) => a.atMs - b.atMs)
      .map((m) => {
        const stamp =
          streamStartMs && m.atMs >= streamStartMs
            ? formatOffset(m.atMs - streamStartMs)
            : new Date(m.atMs).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
        return `${stamp} — ${m.reason}`;
      })
      .join("\n");
    void navigator.clipboard?.writeText(lines).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="space-y-2.5">
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
              onClick={() => void onPost({ streamStartMs: null })}
            >
              Clear mark
            </DockButton>
          </>
        ) : (
          <>
            <DockButton
              disabled={busy}
              onClick={() => void onPost({ streamStartMs: Date.now() })}
            >
              ⏺ Mark stream start
            </DockButton>
            <span className="text-micro text-text-dim">
              …or it auto-marks when you tap Go live on Starting Soon.
            </span>
          </>
        )}
        {moments.length > 0 ? (
          <DockButton disabled={busy} onClick={copyList}>
            {copied ? "✓ Copied" : "Copy timestamps"}
          </DockButton>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {vodUrl ? (
          <>
            <span className="max-w-[16rem] truncate text-micro text-text-muted">
              VOD: <span className="text-text">{vodUrl}</span>
            </span>
            <DockButton
              disabled={busy}
              onClick={() => void onPost({ vodUrl: null })}
            >
              Clear
            </DockButton>
          </>
        ) : (
          <>
            <input
              type="url"
              value={vodDraft}
              onChange={(e) => setVodDraft(e.target.value)}
              placeholder="Paste VOD URL after stream → clickable timestamps"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-caption text-text placeholder:text-text-dim"
            />
            <DockButton
              disabled={busy || vodDraft.trim().length === 0}
              onClick={() => {
                void onPost({ vodUrl: vodDraft.trim() });
                setVodDraft("");
              }}
            >
              Save
            </DockButton>
          </>
        )}
      </div>

      {moments.length === 0 ? (
        <p className="text-caption text-text-dim">
          No clip moments yet — when chat spikes or a big game moment
          lands, it's logged here with the time and what caused it.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {moments.map((m) => (
            <MomentRow
              key={`${m.atMs}:${m.reason}`}
              moment={m}
              streamStartMs={streamStartMs}
              vodUrl={vodUrl}
            />
          ))}
        </ul>
      )}
    </div>
  );
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
              className="text-micro font-semibold tabular-nums text-accent-cyan underline decoration-accent-cyan/50 underline-offset-2"
            >
              ▶ {offsetLabel}
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
          {m.kind === "game-event" ? "Game" : "🔥 Chat"}
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
