"use client";

/**
 * DockPoll — chat-poll controls for the Stream Dock.
 *
 * No poll: a form (question + 2-6 options) that starts one. Running
 * (or closed) poll: live tallies computed from the dock's OWN merged
 * feed via tallyPollVotes — the same pure counter the overlay uses,
 * so both screens agree — plus Close (freezes on stream, stops
 * accepting the vote display as "live") and Clear (removes it).
 *
 * The parent owns the POST round-trip; this component only shapes the
 * partial studio patches.
 */

import { useState } from "react";
import { tallyPollVotes } from "@/lib/multichat/poll";
import type { StudioPoll } from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
import { DockButton } from "./DockClient";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export function DockPoll({
  poll,
  messages,
  busy,
  onPost,
}: {
  poll: StudioPoll | null;
  messages: ReadonlyArray<ChatMessage>;
  busy: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);

  if (poll) {
    const { counts, total } = tallyPollVotes(messages, poll);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-1.5 py-0.5 text-micro font-bold uppercase tracking-wider ${
              poll.status === "open"
                ? "bg-success/15 text-success"
                : "bg-bg-elevated text-text-muted"
            }`}
          >
            {poll.status}
          </span>
          <span className="min-w-0 break-words text-caption font-medium text-text">
            {poll.question}
          </span>
        </div>
        <div className="space-y-1.5">
          {poll.options.map((opt, i) => {
            const count = counts[i] ?? 0;
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            return (
              <div key={`${i}-${opt}`} className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-caption">
                  <span className="min-w-0 break-words text-text">
                    <span className="mr-1 tabular-nums text-text-dim">
                      {i + 1}.
                    </span>
                    {opt}
                  </span>
                  <span className="whitespace-nowrap tabular-nums text-text-muted">
                    {count} · {pct}%
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-bg-elevated">
                  <div
                    className="h-full rounded bg-accent-cyan/70"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-micro text-text-dim">
          {total} vote{total === 1 ? "" : "s"} — chat votes with the option
          number ("2" or "!vote 2").
        </div>
        <div className="flex flex-wrap gap-2">
          {poll.status === "open" ? (
            <DockButton
              disabled={busy}
              onClick={() =>
                void onPost({ poll: { ...poll, status: "closed" } })
              }
            >
              Close poll
            </DockButton>
          ) : null}
          <DockButton
            danger
            disabled={busy}
            onClick={() => void onPost({ poll: null })}
          >
            Clear
          </DockButton>
        </div>
      </div>
    );
  }

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canStart = question.trim().length > 0 && filled.length >= MIN_OPTIONS;

  const setOption = (i: number, v: string) =>
    setOptions((prev) => prev.map((o, j) => (j === i ? v : o)));

  const start = async () => {
    await onPost({
      poll: { question: question.trim(), options: filled, status: "open" },
    });
    setQuestion("");
    setOptions(["", ""]);
  };

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Poll question"
        className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
      />
      {options.map((opt, i) => (
        <div key={i} className="flex min-w-0 items-center gap-1.5">
          <input
            type="text"
            value={opt}
            onChange={(e) => setOption(i, e.target.value)}
            placeholder={`Option ${i + 1}`}
            className="w-full min-w-0 rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-caption text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
          {options.length > MIN_OPTIONS ? (
            <button
              type="button"
              aria-label={`Remove option ${i + 1}`}
              onClick={() =>
                setOptions((prev) => prev.filter((_, j) => j !== i))
              }
              className="rounded border border-border px-1.5 py-1 text-micro text-text-muted hover:border-danger hover:text-danger"
            >
              ✕
            </button>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {options.length < MAX_OPTIONS ? (
          <DockButton
            onClick={() => setOptions((prev) => [...prev, ""])}
          >
            + Add option
          </DockButton>
        ) : null}
        <DockButton disabled={busy || !canStart} onClick={() => void start()}>
          Start poll
        </DockButton>
      </div>
      <p className="text-micro text-text-dim">
        Viewers vote by typing the option number in any connected chat.
      </p>
    </div>
  );
}
