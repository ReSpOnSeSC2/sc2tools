"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { useApi } from "@/lib/clientApi";
import { HUMDINGERS_FILE, humdingersBuildFile } from "@/lib/humdingers";
import { decodeChunks, setHostConfig, type StoredChunk, type TapeChunk, type TapeSummary } from "@/lib/humdingers/tapeSync";
import { IDLE_TICKS, clock, goalTimes, idleSpans, tapeEvents, type TapeEvent, type TapeEventKind } from "@/lib/humdingers/tapeTimeline";
import { formatDateTime, formatNumber } from "@/lib/i18n/format";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";

export type TapeResp = {
  tape: {
    userId: string; session: string; build: string; ticks: number; bytes: number; final: boolean;
    summary: TapeSummary | null; startedAt: string | null; lastAt: string | null; chunks: StoredChunk[];
  };
};
/** G.tape.status() of the game in replay (the game's docs/api/tape.md). */
export type ReplayStatus = {
  tick: number; end: number; playing: boolean; speed: number; seeking: boolean; target: number; ended: boolean;
  drift: number; gaps: number[]; held: string[]; scene: string; build: string;
};
type ReplayGame = { status(): ReplayStatus | null; control(order: { play?: boolean; speed?: number; seek?: number; sound?: boolean }): boolean; error?: string };
type GameWindow = Window & { G?: { tape?: ReplayGame }; HUM_BUILD?: { build?: string } };

const SPEEDS = [1, 2, 4, 8, 16] as const;
const BUTTONS: ReadonlyArray<[string, string]> = [
  ["up", "Up"], ["down", "Down"], ["left", "Left"], ["right", "Right"], ["ok", "OK"], ["back", "Back"],
  ["menu", "Menu"], ["run", "Run"], ["ride", "Ride"], ["tune", "Tune"], ["map", "Map"], ["radio", "Radio"],
];
/** Marks on the timeline; the rest is in the list below it. */
const MARK: Partial<Record<TapeEventKind, string>> = {
  fight: "bg-warning", won: "bg-success", lost: "bg-danger", gameover: "bg-danger", save: "bg-accent-cyan",
  level: "bg-accent", hint: "bg-aurora-3", goal: "bg-text-dim", start: "bg-text",
};
const POLL_MS = 200;

/**
 * /admin/humdingers/watch/<userId>/<session> — one player's visit to
 * Humdingers replayed in the real game (ADR 0113). The tape's buttons drive
 * the game build the visit was recorded on when the site still keeps it, else
 * the current build, which stops matching once the game changed under the
 * player; the page says when that happens.
 */
export function HumdingersWatch({ userId, session }: { userId: string; session: string }) {
  const path = `/v1/admin/humdingers/tapes/${encodeURIComponent(userId)}/${encodeURIComponent(session)}`;
  const request = useApi<TapeResp>(path, { revalidateOnFocus: false, revalidateIfStale: false });
  const tape = request.data?.tape ?? null;
  const [chunks, setChunks] = useState<TapeChunk[] | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!tape) return;
    let live = true;
    void decodeChunks(tape.chunks).then((decoded) => { if (live) setChunks(decoded); });
    const kept = humdingersBuildFile(tape.build);
    if (!kept) setSrc(HUMDINGERS_FILE);
    else void fetch(kept, { method: "HEAD", cache: "no-store" })
      .then((response) => { if (live) setSrc(response.ok ? kept : HUMDINGERS_FILE); })
      .catch(() => { if (live) setSrc(HUMDINGERS_FILE); });
    return () => { live = false; };
  }, [tape]);

  const header = (
    <AdminPageHeader anchor="humdingers-replays" title="Humdingers replay"
      description="One visit, replayed in the game from the player's own button presses."
      actions={<Link href="/admin/humdingers" className="text-caption text-text-dim hover:text-text">← Humdingers</Link>} />
  );
  if (request.error?.status === 403 || request.error?.status === 401) return <ForbiddenCard />;
  if (request.error?.status === 404) {
    return <div className="space-y-6">{header}<Card padded><p className="text-caption">This visit has no tape. Tapes are kept for 90 days.</p></Card></div>;
  }
  if (request.error) return <div className="space-y-6">{header}<RequestError error={request.error} onRetry={() => void request.mutate()} /></div>;
  if (!tape || !chunks || !src) return <div className="space-y-6">{header}<LoadingRows rows={6} /></div>;
  return <div className="space-y-6">{header}<Replay tape={tape} chunks={chunks} src={src} /></div>;
}

function Replay({ tape, chunks, src }: { tape: TapeResp["tape"]; chunks: TapeChunk[]; src: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(0);
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [frameBuild, setFrameBuild] = useState<string | null>(null);
  const [speed, setSpeed] = useState<number>(2);
  const [sound, setSound] = useState(false);
  const resume = useRef<{ seek: number; play: boolean } | null>(null);
  const end = useMemo(() => chunks.reduce((max, chunk) => Math.max(max, chunk.to), 0), [chunks]);
  const events = useMemo(() => tapeEvents(chunks), [chunks]);
  const idle = useMemo(() => idleSpans(chunks, end), [chunks, end]);
  const goals = useMemo(() => goalTimes(events, end).slice(0, 3), [events, end]);

  // The game reads the tape from this window when its frame boots (its js/systems/host.js). A layout effect runs in the same
  // task that inserts the frame, so the tape is there before any of the frame's scripts can run.
  useLayoutEffect(() => {
    setHostConfig({ v: 1, replay: { chunks } });
    return () => setHostConfig(null);
  }, [chunks]);

  const game = useCallback((): ReplayGame | null => {
    try { return (frameRef.current?.contentWindow as GameWindow | null)?.G?.tape ?? null; } catch { return null; }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const replay = game();
      try { setStatus(replay?.status() ?? null); } catch { setStatus(null); }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [game, mount]);

  const onLoad = useCallback(() => {
    const view = frameRef.current?.contentWindow as GameWindow | null;
    const replay = view?.G?.tape ?? null;
    setFrameBuild(view?.HUM_BUILD?.build ?? null);
    if (!replay || !replay.status()) { setProblem(replay?.error ? `The game refused this tape: ${replay.error}.` : "The game did not start the replay."); return; }
    setProblem(null);
    replay.control({ speed, sound });
    const next = resume.current;
    resume.current = null;
    if (next?.seek) replay.control({ seek: next.seek });
    if (next?.play) replay.control({ play: true });
  }, [speed, sound]);

  const seek = useCallback((tick: number) => {
    const target = Math.max(0, Math.min(end, Math.round(tick)));
    const replay = game(), now = replay?.status();
    if (replay && now && target >= now.tick) { replay.control({ seek: target }); return; }
    // Backwards: the game starts the tape again and runs to the tick (the page cannot rewind a running game).
    resume.current = { seek: target, play: Boolean(now?.playing) };
    setStatus(null);
    setMount((value) => value + 1);
  }, [end, game]);

  const togglePlay = () => { const replay = game(), now = replay?.status(); if (replay && now) replay.control({ play: !now.playing }); };
  const pickSpeed = (value: number) => { setSpeed(value); game()?.control({ speed: value }); };
  const toggleSound = () => { const next = !sound; setSound(next); game()?.control({ sound: next }); };

  const tick = status?.tick ?? 0;
  // Only a replay on the current build can be on the wrong build, and that is known once the frame says which build it is.
  const exact = src !== HUMDINGERS_FILE || frameBuild === null || frameBuild === tape.build;
  const summary = tape.summary;
  return (
    <>
      <Card padded>
        <dl className="grid gap-x-6 gap-y-1 text-caption sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Started">{tape.startedAt ? formatDateTime(tape.startedAt) : "–"}</Fact>
          <Fact label="Length">{clock(end)} of play</Fact>
          <Fact label="Fights">{summary ? `${formatNumber(summary.fights ?? 0)} (won ${formatNumber(summary.won ?? 0)}, lost ${formatNumber(summary.lost ?? 0)})` : "–"}</Fact>
          <Fact label="Hints read">{summary ? formatNumber(summary.hints ?? 0) : "–"}</Fact>
          <Fact label="Longest on one goal">{goals[0] ? `${clock(goals[0].ticks)}: ${goals[0].goal}` : "No goal yet"}</Fact>
          <Fact label="Idle">{idle.length ? `${formatNumber(idle.length)} stretches of a minute or more` : "Never a minute without input"}</Fact>
          <Fact label="Build">{tape.build}{exact ? "" : " (not kept: replaying on the current build)"}</Fact>
          <Fact label="Account">{tape.userId}</Fact>
        </dl>
      </Card>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {!exact ? (
        <Notice tone="warning">
          This visit was recorded on build {tape.build}, which the site no longer keeps, so it plays on the current build
          ({frameBuild ?? "loading"}). It matches until the player reaches something that changed since.
        </Notice>
      ) : null}
      {status && status.drift >= 0 ? (
        <Notice tone="warning">
          From {clock(status.drift)} the replay no longer matches what the player saw. The timeline below is still exact.
        </Notice>
      ) : null}
      {status && status.gaps.length ? (
        <Notice tone="warning">Part of this tape never arrived (the player&apos;s connection), so the replay may drift after it.</Notice>
      ) : null}

      <Card padded>
        <div className="mx-auto w-full max-w-[768px]">
          <div className="relative aspect-[16/9] w-full overflow-hidden rounded-md bg-black">
            <iframe key={mount} ref={frameRef} src={src} title="Humdingers replay" tabIndex={-1} onLoad={onLoad}
              className="pointer-events-none absolute inset-0 h-full w-full border-0" />
            {status?.seeking ? (
              <p role="status" className="absolute inset-x-0 bottom-2 text-center text-micro text-white/80">
                Fast-forwarding to {clock(status.target)}…
              </p>
            ) : null}
          </div>
          <Timeline end={end} tick={tick} events={events} idle={idle} onSeek={seek} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary" onClick={togglePlay} disabled={!status || status.ended}
              aria-label={status?.playing ? "Pause" : "Play"}>
              {status?.ended ? "Ended" : status?.playing ? "Pause" : "Play"}
            </Button>
            <div role="group" aria-label="Speed" className="flex gap-1">
              {SPEEDS.map((value) => (
                <Button key={value} size="sm" variant={value === speed ? "secondary" : "ghost"} aria-pressed={value === speed}
                  onClick={() => pickSpeed(value)}>{value}x</Button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={toggleSound} aria-pressed={sound}>{sound ? "Sound on" : "Sound off"}</Button>
            <span className="ml-auto tabular-nums text-caption text-text-dim">{clock(tick)} / {clock(end)}</span>
          </div>
          <HeldButtons held={status?.held ?? []} />
        </div>
      </Card>

      <EventsCard events={events} idle={idle} onSeek={seek} />
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-micro uppercase tracking-wide text-text-dim">{label}</dt>
      <dd className="break-words text-text">{children}</dd>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warning" | "danger"; children: React.ReactNode }) {
  const colors = tone === "danger" ? "border-danger/30 bg-danger/10 text-danger" : "border-warning/30 bg-warning/10 text-warning";
  return <p role="status" className={`rounded-lg border px-4 py-3 text-caption ${colors}`}>{children}</p>;
}

function Timeline({ end, tick, events, idle, onSeek }: { end: number; tick: number; events: TapeEvent[]; idle: Array<{ from: number; to: number }>; onSeek: (tick: number) => void }) {
  const at = (value: number) => `${end ? Math.min(100, (value / end) * 100) : 0}%`;
  // The bar seeks once it is let go: going back starts the tape again, which must not happen at every step of a drag.
  const [drag, setDrag] = useState<number | null>(null);
  const commit = () => { if (drag !== null) { onSeek(drag); setDrag(null); } };
  return (
    <div className="mt-3">
      <div className="relative h-6 rounded bg-bg-elevated">
        {idle.map((span) => (
          <span key={`idle-${span.from}`} aria-hidden className="absolute inset-y-0 bg-text-dim/20"
            style={{ left: at(span.from), width: `calc(${at(span.to)} - ${at(span.from)})` }} />
        ))}
        {events.filter((event) => MARK[event.kind]).map((event, index) => (
          <button key={`${event.tick}-${index}`} type="button" title={`${clock(event.tick)} ${event.label}`} aria-label={`${clock(event.tick)} ${event.label}`}
            onClick={() => onSeek(event.tick)}
            className={`absolute top-1 h-4 w-1 -translate-x-1/2 rounded-sm ${MARK[event.kind]} hover:scale-150`} style={{ left: at(event.tick) }} />
        ))}
        <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent" style={{ left: at(tick) }} />
      </div>
      <input type="range" min={0} max={end} step={60} value={drag ?? Math.min(tick, end)} aria-label="Position in the visit"
        aria-valuetext={clock(drag ?? tick)} onChange={(event) => setDrag(Number(event.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} className="mt-2 w-full accent-accent" />
    </div>
  );
}

function HeldButtons({ held }: { held: string[] }) {
  return (
    <div className="mt-3" aria-label="Buttons the player is holding">
      <p className="text-micro uppercase tracking-wide text-text-dim">Buttons held</p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {BUTTONS.map(([id, label]) => {
          const down = held.includes(id);
          return (
            <li key={id} className={`rounded border px-2 py-0.5 text-micro tabular-nums ${down ? "border-accent bg-accent/20 text-text" : "border-line text-text-dim"}`}>
              <span className="sr-only">{down ? "held: " : ""}</span>{label}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EventsCard({ events, idle, onSeek }: { events: TapeEvent[]; idle: Array<{ from: number; to: number }>; onSeek: (tick: number) => void }) {
  const rows = useMemo(() => {
    const idleRows: TapeEvent[] = idle.map((span) => ({ tick: span.from, kind: "screen", label: `No input for ${clock(span.to - span.from)}` }));
    return [...events, ...idleRows].sort((a, b) => a.tick - b.tick);
  }, [events, idle]);
  return (
    <Card title={`What happened (${formatNumber(rows.length)})`} headingLevel={2}>
      <p className="text-caption text-text-muted">
        Click a line to jump there. Grey stretches on the timeline had no button pressed for {clock(IDLE_TICKS)} or more.
      </p>
      {rows.length ? (
        <ol className="mt-3 max-h-96 overflow-y-auto text-caption">
          {rows.map((row, index) => (
            <li key={`${row.tick}-${index}`} className="border-t border-line">
              <button type="button" onClick={() => onSeek(row.tick)} className="flex w-full gap-3 py-1.5 text-left hover:bg-bg-elevated">
                <span className="w-14 shrink-0 tabular-nums text-text-dim">{clock(row.tick)}</span>
                <span className="min-w-0 break-words">{row.label}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : <p className="mt-3 text-caption">Nothing happened on this visit yet: the player stayed on the title screen.</p>}
    </Card>
  );
}
