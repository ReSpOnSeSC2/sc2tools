"use client";

import { Fragment } from "react";
import type { ReportSentence as Sentence } from "@/lib/battleReport/plan";
import { formatGameClock } from "@/lib/macro";

const METADATA = new Set(["setting", "mmr", "plan", "opener", "opponent-opener", "opponent-correction"]);

function TimeLink({ time, label, gameId, onSeek }: { time: number; label: string; gameId: string; onSeek: (time: number) => void }) {
  return <a href={`/app/game/${encodeURIComponent(gameId)}?t=${Math.floor(time)}#replay`} aria-label={`Seek replay to ${label}`} className="rounded text-accent underline decoration-accent/40 underline-offset-4 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); onSeek(time);
  }}>{label}</a>;
}

/** Only clocks identified by the fact assembler become replay seeks. */
export function ReportSentence({ sentence, gameId, onSeek }: { sentence: Sentence; gameId: string; onSeek: (time: number) => void }) {
  const chunks = sentence.text.split(/(\b\d{1,3}:\d{2}\b)/g);
  let embedded = 0;
  const content = chunks.map((chunk, index) => {
    const match = /^(\d+):(\d{2})$/.exec(chunk);
    const time = match ? Number(match[1]) * 60 + Number(match[2]) : null;
    const actual = time === null || METADATA.has(sentence.factId) ? undefined : sentence.timestamps.find((value) => Math.floor(value) === time);
    if (actual !== undefined) embedded++;
    return <Fragment key={index}>{actual !== undefined ? <TimeLink time={actual} label={chunk} gameId={gameId} onSeek={onSeek} /> : chunk}</Fragment>;
  });
  return <>{content}{embedded ? null : <span className="whitespace-nowrap font-sans text-micro"> [<TimeLink time={sentence.time} label={formatGameClock(sentence.time)} gameId={gameId} onSeek={onSeek} />]</span>}</>;
}
