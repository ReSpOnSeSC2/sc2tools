"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import type { ReferenceBuildStep } from "@/lib/buildOrderReference";
import { fmtClock } from "@/lib/guides/format";
import { spokenStepName } from "@/lib/ghostVoice";
import { loadYouTubeApi, type YouTubePlayer } from "@/lib/youtubeIframeApi";

type PlayerPhase = "idle" | "loading" | "ready" | "error";

export function currentWatchStep(steps: readonly ReferenceBuildStep[], clock: number, offset: number): number {
  let index = -1;
  let time = -1;
  steps.forEach((step, i) => {
    if (step.t !== null && step.t >= time && step.t <= clock - offset) {
      index = i;
      time = step.t;
    }
  });
  return index;
}

function iframeFor(videoId: string, title: string, start: number) {
  const frame = document.createElement("iframe");
  const params = new URLSearchParams({ enablejsapi: "1", autoplay: "1", rel: "0", start: String(start), origin: location.origin });
  frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?${params}`;
  frame.title = title;
  frame.allow = "autoplay; encrypted-media; picture-in-picture";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.className = "absolute inset-0 h-full w-full";
  return frame;
}

function useWatchPlayer(host: RefObject<HTMLDivElement | null>, videoId: string, title: string, start: number | null, attempt: number) {
  const player = useRef<YouTubePlayer | null>(null);
  const [phase, setPhase] = useState<PlayerPhase>("idle");
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const node = host.current;
    if (start === null || !node) return;
    let live = true;
    setPhase("loading");
    setClock(start);
    const frame = iframeFor(videoId, title, start);
    node.appendChild(frame);
    let poll: number | undefined;
    let failed = false;
    const fail = () => {
      if (!live || failed) return;
      failed = true;
      window.clearTimeout(deadline);
      window.clearInterval(poll);
      setPhase("error");
    };
    const deadline = window.setTimeout(fail, 15_000);
    void loadYouTubeApi().then((api) => {
      if (!live || failed) return;
      player.current = new api.Player(frame, {
        width: "100%", height: "100%", playerVars: {},
        events: {
          onReady: ({ target }) => {
            if (!live || failed) return;
            window.clearTimeout(deadline);
            setPhase("ready");
            poll = window.setInterval(() => {
              const time = target.getCurrentTime?.();
              if (time !== undefined && Number.isFinite(time)) setClock(time);
            }, 250);
          },
          onStateChange() {},
          onError: fail,
        },
      });
    }).catch(fail);
    return () => {
      live = false;
      window.clearTimeout(deadline);
      window.clearInterval(poll);
      player.current?.destroy();
      player.current = null;
      node.replaceChildren();
    };
  }, [host, videoId, title, start, attempt]);
  return { player, phase, clock };
}

function StepList({ steps, active, seek }: { steps: readonly ReferenceBuildStep[]; active: number; seek: (seconds: number) => void }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const box = list.current;
    const row = box?.children[active];
    if (!box || !row) return;
    const outer = box.getBoundingClientRect(), inner = row.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop += inner.top - outer.top;
    else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
  }, [active]);

  return steps.length === 0 ? <p className="text-body text-text-muted">This build has no recorded steps.</p> : (
    <ol ref={list} aria-label="Build steps" className="max-h-96 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
      {steps.map((step, index) => {
        const name = spokenStepName(step.action.replace(/^(Build|Train|Research|Morph)(?=[A-Z])/, ""));
        const content = <><span className="shrink-0 tabular-nums text-text-muted">{fmtClock(step.t)}</span><span className="min-w-0 break-words">{name}{step.supply !== null ? ` · ${step.supply} supply` : ""}</span></>;
        return <li key={index} aria-current={index === active ? "step" : undefined} className={index === active ? "rounded-lg bg-bg-elevated" : undefined}>
          {step.t === null ? <div className="flex gap-3 p-2">{content}</div> : (
            <button type="button" onClick={() => seek(step.t ?? 0)} className="flex min-h-11 w-full gap-3 rounded-lg p-2 text-left hover:bg-bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{content}</button>
          )}
        </li>;
      })}
    </ol>
  );
}

export function WatchSync({ videoId, offset, steps, title }: { videoId: string; offset: number; steps: readonly ReferenceBuildStep[]; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<number | null>(null);
  const [attempt, retry] = useState(0);
  const { player, phase, clock } = useWatchPlayer(host, videoId, title, start, attempt);
  const seek = (seconds: number) => {
    if (phase === "ready") player.current?.seekTo?.(seconds + offset, true);
    else if (phase !== "loading") { setStart(seconds + offset); retry(attempt + 1); }
  };
  function startVideo() {
    video.current?.focus();
    if (phase === "error") retry(attempt + 1);
    else seek(0);
  }
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
    <div className="min-w-0 space-y-2">
      <div ref={video} role="group" aria-label="Build video" tabIndex={-1} className="relative flex aspect-video min-h-[200px] w-full items-center justify-center overflow-hidden rounded-xl border border-line bg-bg-elevated">
        <div ref={host} className="absolute inset-0" hidden={phase === "idle" || phase === "error"} />
        {phase === "idle" ? <Button className="min-h-11" onClick={startVideo}>Play video</Button> : null}
        {phase === "loading" ? <p role="status" className="relative rounded-lg bg-bg-surface px-3 py-2">Loading video…</p> : null}
        {phase === "error" ? <div className="space-y-2 text-center"><p role="alert">YouTube playback is unavailable.</p><Button className="min-h-11" onClick={startVideo}>Retry video</Button></div> : null}
      </div>
      <a className="inline-flex min-h-11 items-center text-text underline underline-offset-4" href={`https://www.youtube.com/watch?v=${videoId}&t=${offset}s`} target="_blank" rel="noopener noreferrer">Watch on YouTube (opens in a new tab)</a>
    </div>
    <StepList steps={steps} active={phase === "ready" ? currentWatchStep(steps, clock, offset) : -1} seek={seek} />
  </div>;
}
