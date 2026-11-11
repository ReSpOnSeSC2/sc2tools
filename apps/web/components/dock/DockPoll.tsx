"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLocalStorageState } from "@/lib/useLocalStorageState";
import { POLL_PRESETS, POLL_VOTE_HINT, formatPollRemaining, pollIsClosed, pollRemainingMs, sanitizePollForm, type PollDurationSec, type PollForm } from "@/lib/multichat/poll";
import { usePollClock } from "@/lib/multichat/usePollClock";
import { usePollTally } from "@/lib/multichat/usePollTally";
import type { StudioPoll } from "@/lib/multichat/useStudioState";
import type { ChatMessage } from "@/lib/multichat/types";
import { DockButton, DockInput } from "./DockControls";
import { PollDurationSelect } from "./PollDurationSelect";
import type { DockPost } from "./dockActions";
import { DockActionNotice, DockSnapshotState, useDockPanelActions } from "./useDockPanelActions";

const EMPTY_FORM: PollForm = { question: "", options: ["", ""], durationSec: null };
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;

export function DockPoll({ token = "", poll, messages, busy, studioReady = true, onPost, chooseBuild }: {
  token?: string; poll: StudioPoll | null; messages: ReadonlyArray<ChatMessage>; busy: boolean; studioReady?: boolean;
  onPost: DockPost; chooseBuild?: () => void;
}) {
  const now = usePollClock(poll);
  const tally = usePollTally(messages, poll, now);
  const closed = poll ? pollIsClosed(poll, now) : false;
  const remaining = poll ? pollRemainingMs(poll, now) : null;
  const requestedClose = useRef<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [savedForm, remember] = useLocalStorageState<unknown>(`sc2tools:dock:poll-form:${token}`, null);
  const lastForm = useMemo(() => sanitizePollForm(savedForm), [savedForm]);
  const currentForm = useMemo(() => poll?.meta?.kind === "build" ? null : sanitizePollForm(poll), [poll]);
  const draft = sanitizePollForm(form);
  useEffect(() => { if (token && currentForm) remember(currentForm); }, [token, currentForm, remember]);
  const { run, notice, pending } = useDockPanelActions(studioReady, busy, onPost, {
    start: () => draft ? {
      patch: { poll: { question: draft.question, options: draft.options, status: "open", ...(draft.durationSec ? { durationSec: draft.durationSec } : {}) } },
      message: "Poll started",
      after: () => { if (token) remember(draft); setForm(EMPTY_FORM); },
    } : null,
    close: () => poll?.status === "open" ? { patch: { poll: { ...poll, status: "closed" } }, message: "Poll closed" } : null,
    clear: () => ({ patch: { poll: null }, message: "Poll cleared" }),
    again: () => currentForm ? { patch: { poll: null }, message: "Poll form restored", after: () => setForm(currentForm) } : null,
  });
  useEffect(() => {
    if (poll?.status !== "open" || !closed || busy || pending || !studioReady || requestedClose.current === poll.startedAtMs) return;
    requestedClose.current = poll.startedAtMs;
    void run("close");
  }, [poll, closed, busy, pending, studioReady, run]);
  if (!studioReady) return <DockSnapshotState />;

  return <fieldset disabled={busy || pending} className="min-w-0 space-y-2">
    <DockActionNotice message={notice} />
    {poll && tally ? <>
      <PollResult poll={poll} tally={tally} closed={closed} remaining={remaining} />
      <div className="flex flex-wrap gap-2">
        {!closed ? <DockButton onClick={() => void run("close")}>Close poll</DockButton> : null}
        {closed && currentForm ? <DockButton onClick={() => void run("again")}>Run again</DockButton> : null}
        <DockButton danger onClick={() => void run("clear")}>Clear</DockButton>
      </div>
    </> : <PollFormFields form={form} setForm={setForm} lastForm={lastForm} chooseBuild={chooseBuild}
      canStart={Boolean(draft)} onStart={() => void run("start")} />}
  </fieldset>;
}

function PollResult({ poll, tally, closed, remaining }: {
  poll: StudioPoll; tally: { counts: number[]; total: number }; closed: boolean; remaining: number | null;
}) {
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded px-1.5 py-0.5 text-micro font-bold uppercase tracking-wider ${closed ? "bg-bg-elevated text-text-muted" : "bg-success/15 text-success"}`}>{closed ? "closed" : "open"}</span>
      <span className="min-w-0 break-words text-caption font-medium text-text">{poll.question}</span>
      {!closed && remaining !== null ? <span className="tabular-nums text-caption text-text-muted">{formatPollRemaining(remaining)} left</span> : null}
    </div>
    <div className="space-y-1.5">
      {poll.options.map((option, index) => {
        const count = tally.counts[index] ?? 0;
        const pct = tally.total ? Math.round(count / tally.total * 100) : 0;
        return <div key={index} className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 text-caption">
            <span className="min-w-0 break-words text-text">{index + 1}. {option}</span>
            <span className="whitespace-nowrap tabular-nums text-text-muted">{count} · {pct}%</span>
          </div>
          <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-bg-elevated"><div className="h-full rounded bg-accent-cyan/70" style={{ width: `${pct}%` }} /></div>
        </div>;
      })}
    </div>
    <p className="text-micro text-text-dim">{tally.total} vote{tally.total === 1 ? "" : "s"}. {closed ? null : POLL_VOTE_HINT}</p>
  </>;
}

function PollFormFields({ form, setForm, lastForm, chooseBuild, canStart, onStart }: {
  form: PollForm; setForm: (value: PollForm) => void; lastForm: PollForm | null; chooseBuild?: () => void;
  canStart: boolean; onStart: () => void;
}) {
  const changeDuration = (durationSec: PollDurationSec | null) => setForm({ ...form, durationSec });
  return <>
    <div className="flex flex-wrap gap-1" role="group" aria-label="Poll presets">
      {POLL_PRESETS.filter((preset) => preset.mode === "custom" || chooseBuild).map((preset) =>
        <DockButton key={preset.id} type="button" onClick={() => {
          if (preset.mode === "build") chooseBuild?.();
          else setForm({ ...form, question: preset.question, options: [...preset.options] });
        }}>{preset.question}</DockButton>)}
      {lastForm ? <DockButton type="button" onClick={() => setForm(lastForm)}>Run again</DockButton> : null}
    </div>
    <DockInput type="text" value={form.question} maxLength={120} onChange={(event) => setForm({ ...form, question: event.target.value })}
      placeholder="Poll question" aria-label="Poll question" className="w-full min-w-0" />
    {form.options.map((option, index) => <div key={index} className="flex min-w-0 items-center gap-1.5">
      <DockInput type="text" value={option} maxLength={120}
        onChange={(event) => setForm({ ...form, options: form.options.map((value, at) => at === index ? event.target.value : value) })}
        placeholder={`Option ${index + 1}`} aria-label={`Option ${index + 1}`} className="w-full min-w-0" />
      {form.options.length > MIN_OPTIONS ? <DockButton type="button" aria-label={`Remove option ${index + 1}`}
        onClick={() => setForm({ ...form, options: form.options.filter((_, at) => at !== index) })}><X aria-hidden className="h-4 w-4" /></DockButton> : null}
    </div>)}
    <PollDurationSelect value={form.durationSec} onChange={changeDuration} />
    <div className="flex flex-wrap gap-2">
      {form.options.length < MAX_OPTIONS ? <DockButton type="button" onClick={() => setForm({ ...form, options: [...form.options, ""] })}>+ Add option</DockButton> : null}
      <DockButton disabled={!canStart} onClick={onStart}>Start poll</DockButton>
    </div>
    <p className="text-micro text-text-dim">{POLL_VOTE_HINT}</p>
  </>;
}
