"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { PlayerChooser } from "@/components/instant/PlayerChooser";
import { errorCopy } from "@/lib/instant/errorCopy";
import { useInstantSession } from "@/lib/instant/useInstantSession";
import type { MeCandidate } from "@/lib/instant/meDetection";
import type { ErrorKind } from "@/lib/instant/types";
import { instantPreview, type PreviewDossier } from "./replayDemoPreview";

export type DemoRequest = { file: File; id: number };
export interface BrowserDemoProps {
  request: DemoRequest | null;
  onSuccess: (request: DemoRequest, dossier: PreviewDossier) => void;
  onBusy: (request: DemoRequest, busy: boolean) => void;
  onClose: () => void;
  onChooseAnother: () => void;
}
export const DEMO_SESSION_OPTIONS = { maxFiles: 1, onlyOneVsOne: true, initialDateWindow: { kind: "all" as const }, refreshPolicy: false };
const supported = () => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && !!globalThis.crypto?.subtle;

/** Mounted only after real hover/focus/drop intent. No saved games, policy
 * refresh, upload or API fallback: this session is memory-only. */
export function ReplayDemoBrowserSession(props: BrowserDemoProps) {
  const session = useInstantSession(DEMO_SESSION_OPTIONS);
  const { addFiles, start, cancel, reset, prewarm } = session;
  const callbacks = useRef(props); callbacks.current = props;
  const active = useRef<{ request: DemoRequest; current: boolean; started: boolean; complete: boolean } | null>(null);
  const roster = useRef<MeCandidate[]>([]);
  const errorHeading = useRef<HTMLHeadingElement>(null);
  const [failure, setFailure] = useState<ErrorKind | "unsupported" | null>(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!failure || !props.request) return;
    const timer = setTimeout(() => errorHeading.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [failure, props.request]);
  // The component itself is intent-gated; this never runs on page view.
  useEffect(() => { if (supported()) prewarm(); }, [prewarm]);
  useEffect(() => {
    if (!props.request) { active.current = null; reset(); return; }
    const run = { request: props.request, current: true, started: false, complete: false }; active.current = run;
    roster.current = []; setFailure(null); reset();
    if (!supported()) { setFailure("unsupported"); callbacks.current.onBusy(run.request, false); return () => { run.current = false; }; }
    callbacks.current.onBusy(run.request, true);
    void (async () => {
      await addFiles([run.request.file], "picker");
      if (!run.current || active.current !== run) return;
      run.started = true; await start();
    })().catch(() => { if (run.current && active.current === run) { setFailure("analysis_failed"); callbacks.current.onBusy(run.request, false); } });
    return () => { run.current = false; cancel(); };
  }, [props.request, retry, addFiles, start, reset, cancel]);
  useEffect(() => {
    const run = active.current;
    if (!run?.current || !run.started || run.complete || props.request !== run.request) return;
    if (session.phase === "choosing") roster.current = session.candidates;
    if (session.phase !== "done" && session.phase !== "error") return;
    if (session.phase === "done" && session.parsed.length === 1) {
      const preview = instantPreview(session.parsed[0], roster.current);
      if (preview) { run.complete = true; callbacks.current.onBusy(run.request, false); callbacks.current.onSuccess(run.request, preview); return; }
    }
    run.complete = true; setFailure(session.error ?? session.failed[0]?.errorKind ?? "analysis_failed"); callbacks.current.onBusy(run.request, false);
  }, [props.request, session.phase, session.candidates, session.parsed, session.error, session.failed]);
  const copy = failure && failure !== "unsupported" ? errorCopy(failure) : null;
  const fileLabel = props.request ? `${props.request.file.name} · ${(props.request.file.size / 1024 / 1024).toFixed(2)} MB` : "";
  return <Modal open={!!props.request} onClose={props.onClose} title={failure ? "Couldn't analyze that replay" : session.phase === "choosing" ? "Choose your player" : "Analyzing in your browser…"}
    description="Runs in your browser — the replay never leaves your device."
    footer={<><Button variant="secondary" onClick={props.onClose}>Cancel</Button>{failure && failure !== "unsupported" ? <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Try again</Button> : null}{failure ? <Button onClick={props.onChooseAnother}>Choose another replay</Button> : null}</>}>
    <p className="mb-3 text-caption text-text-muted [overflow-wrap:anywhere]">{fileLabel}</p>
    {failure ? <div role="alert" className="space-y-3"><h3 ref={errorHeading} tabIndex={-1} className="font-semibold">{failure === "unsupported" ? "This browser cannot run the replay analyzer." : copy?.title}</h3>
      <p>{failure === "unsupported" ? "Your replay has not been uploaded." : copy?.hint}</p>
      {(failure === "unsupported" || failure === "engine_boot_failed" || failure === "engine_unavailable") ? <p>Try a current Chrome or Edge browser, or <Link href="/download" className="min-h-11 font-semibold text-accent underline">use the desktop app</Link>.</p> : null}
    </div> : session.phase === "choosing" ? <PlayerChooser candidates={session.candidates} onChoose={toon => { roster.current = session.candidates; void session.choose(toon); }} onCancel={props.onClose} />
      : <p role="status" className="py-8 text-caption text-text-muted">{session.phase === "booting" || session.phase === "idle" ? "Starting the private analyzer…" : session.phase === "scanning" ? "Reading the replay's players…" : "Reading both build orders…"}</p>}
  </Modal>;
}
