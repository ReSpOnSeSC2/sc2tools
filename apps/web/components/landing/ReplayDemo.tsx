"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDropTarget } from "@/components/instant/useDropTarget";
import { useReplayAccept } from "@/components/instant/useReplayAccept";
import { isReplayFileName, MAX_REPLAY_BYTES } from "@/lib/instant/fileIntake";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  FileUp,
  Loader2,
  Sparkles,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { getInstantImportMode } from "@/lib/instant/flag";
import { LazyBuildEditorModal as BuildEditorModal } from "@/components/builds/editor/LazyBuildEditorModal";
import { buildLogToEvents } from "@/lib/build-events";
import type { RaceLite, VsRaceLite } from "@/lib/build-rules";
import { SampleReportButton } from "@/components/instant/SampleReportButton";
import { ReplayDemoBrowserIsland } from "./ReplayDemoBrowserIsland";
import type { DemoRequest } from "./ReplayDemoBrowserSession";
import type { PreviewDossier, PreviewPlayer } from "./replayDemoPreview";
import { replayDemoFileSize } from "./replayDemoFileSize";

/**
 * ReplayDemo — landing-page "drop a replay, see the real dossier" CTA.
 *
 * With Instant Analysis enabled for everyone, real intent loads a private
 * one-file browser session. No replay bytes/payload reach the API. Other
 * rollout modes offer desktop recovery without accepting a replay here.
 *
 * On success we open the rich BuildEditorModal in demoMode so the
 * visitor can experience the real "Save as new build" template:
 * source-replay timeline, rule promotion, basics editing, strategy
 * notes — everything except the actual save (which is gated behind
 * sign-up). This is closer to what they'll actually do once signed
 * in than the read-only dossier we used to ship here.
 *
 * No mock data — if analysis fails, we surface the failure and a
 * sign-up CTA instead of pretending we know what's in the file.
 */

interface PreviewError {
  code: "empty_body" | "too_large";
}

const FRIENDLY_ERRORS: Record<PreviewError["code"], string> = {
  empty_body: "That file looked empty — pick another replay?",
  too_large: "That file is bigger than the demo accepts. Pick a smaller one or sign up.",
};

/**
 * "Analyze privately in your browser instead" → /try, shown only once
 * Instant Analysis is rolled out to everyone (build-time flag).
 *
 * Example:
 *   <PrivateTryLink />
 */
function PrivateTryLink() {
  if (getInstantImportMode() !== "all") return null;
  return (
    <p className="text-caption">
      <Link
        href="/try"
        className="inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Analyze more replays in your browser
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </p>
  );
}

export function ReplayDemo() {
  return getInstantImportMode() === "all" ? <BrowserReplayDemo /> : <ReplayDemoUnavailable />;
}

function ReplayDemoUnavailable() {
  return <section aria-labelledby="home-demo-unavailable-title" className="mx-auto max-w-5xl">
    <Card className="!rounded-md">
      <div className="space-y-4">
        <p className="kicker">Build editor demo</p>
        <h2 id="home-demo-unavailable-title" className="font-serif text-[28px] font-semibold tracking-[-0.01em] text-text md:text-[36px]">Turn a replay into a custom build</h2>
        <p className="text-body-lg text-text-muted">The replay demo is currently unavailable. Use the desktop app to sync your games and review their build orders.</p>
        <div className="flex flex-wrap gap-3">
          <LinkButton href="/download" size="lg">Get the desktop app</LinkButton>
          <LinkButton href="/sign-up" variant="secondary" size="lg">Create a free account</LinkButton>
        </div>
      </div>
    </Card>
  </section>;
}

function BrowserReplayDemo() {
  const [browserIntent, setBrowserIntent] = useState(false), [browserRequest, setBrowserRequest] = useState<DemoRequest | null>(null);
  const activeBrowser = useRef<DemoRequest | null>(null), sequence = useRef(0), live = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const dropRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLHeadingElement>(null);
  const playerChoices = useRef<HTMLElement>(null);
  const accept = useReplayAccept();
  const [intakeMessage, setIntakeMessage] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [dossier, setDossier] = useState<PreviewDossier | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // The parsed side opens first. Closing the editor exposes both source
  // choices without placing controls over the modal's title or close button.
  const [perspective, setPerspective] = useState<0 | 1>(0);
  const warm = () => { setBrowserIntent(true); };
  const closeStatus = useCallback(() => {
    sequence.current++; activeBrowser.current = null;
    setBrowserRequest(null); inFlight.current = false; setBusy(false); setStatusOpen(false); dropRef.current?.focus();
  }, []);
  const chooseAnother = () => { closeStatus(); inputRef.current?.click(); };
  const browserBusy = useCallback((request: DemoRequest, value: boolean) => { if (live.current && activeBrowser.current === request) { inFlight.current = value; setBusy(value); } }, []);
  const browserSuccess = useCallback((request: DemoRequest, value: PreviewDossier) => {
    if (!live.current || activeBrowser.current !== request) return;
    activeBrowser.current = null; setBrowserRequest(null); inFlight.current = false; setBusy(false);
    setDossier(value); setStatusOpen(false); setPerspective(0); setEditorOpen(true);
  }, []);
  useEffect(() => { live.current = true; return () => { live.current = false; activeBrowser.current = null; }; }, []);
  const { dragging, handlers } = useDropTarget(busy, (files) => {
    const replays = files.filter((file) => isReplayFileName(file.name));
    if (!replays.length) { setIntakeMessage("That isn't a .SC2Replay file. Drop a replay from your StarCraft II Replays folder."); return; }
    setIntakeMessage(replays.length > 1 ? `Using ${replays[0].name}. The demo reads one replay at a time.` : "");
    void onPick(replays[0]);
  }, warm);
  useEffect(() => {
    if (!statusOpen || !error) return;
    const timer = window.setTimeout(() => errorRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [statusOpen, error]);
  useEffect(() => {
    if (!dossier || editorOpen) return;
    const timer = setTimeout(() => playerChoices.current?.querySelector<HTMLButtonElement>(`[data-player-index="${perspective}"]`)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [dossier, editorOpen, perspective]);

  const me = dossier?.players[perspective] ?? null;
  const opp = dossier?.players[perspective === 0 ? 1 : 0] ?? null;
  const editorEvents = useMemo(
    () => (me ? buildLogToEvents(me.build_log, me.race) : []),
    [me],
  );
  const editorRace: RaceLite = coerceRace(me?.race);
  const editorVsRace: VsRaceLite = coerceVsRace(opp?.race);

  function onPick(file: File | null) {
    if (!file || inFlight.current) return;
    if (!isReplayFileName(file.name)) { setIntakeMessage("That isn't a .SC2Replay file. Drop a replay from your StarCraft II Replays folder."); return; }
    setFileSize(file.size);
    dropRef.current?.focus();
    setFilename(file.name);
    setDossier(null);
    setError(null);
    setEditorOpen(false);
    setPerspective(0);
    setStatusOpen(true);
    if (file.size === 0) {
      setError({ code: "empty_body" });
      return;
    }
    if (file.size > MAX_REPLAY_BYTES) {
      setError({ code: "too_large" });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const request = { file, id: ++sequence.current }; activeBrowser.current = request;
    setBrowserIntent(true); setBrowserRequest(request); setStatusOpen(false);
  }

  return (
    <section className="mx-auto max-w-5xl">
      <Card {...handlers} onPointerEnter={warm} onFocusCapture={warm} padded={false} className={`relative overflow-hidden !rounded-md ${dragging ? "ring-2 ring-accent" : ""}`}>
        {dragging ? <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-bg/90 text-h3 text-accent">Drop to analyze</div> : null}
        <div className="grid items-center gap-6 p-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10 md:p-10">
          <div className="space-y-4">
            <p className="kicker flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Build editor demo
            </p>
            <h2 className="font-serif text-[28px] font-semibold tracking-[-0.01em] text-text md:text-[36px]">
              Turn a replay into a custom build
            </h2>
            <p className="text-body-lg text-text-muted">
              Drop one 1v1 replay and we open the build editor on your build order.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Button
                ref={dropRef}
                variant="primary"
                size="lg"
                onClick={() => { warm(); inputRef.current?.click(); }}
                iconLeft={<Upload className="h-5 w-5" aria-hidden />}
              >
                Choose a replay
              </Button>
              <input
                ref={inputRef}
                type="file"
                aria-label="Replay for the build editor demo"
                // Keep the shared iOS picker workaround, but this demo takes
                // one replay rather than /try's optional archive collection.
                accept={accept ? ".SC2Replay" : undefined}
                className="sr-only"
                onChange={(e) => { const file = e.currentTarget.files?.[0] ?? null; e.currentTarget.value = ""; setIntakeMessage(""); void onPick(file); }}
              />
              <LinkButton href="/sign-up" variant="secondary" size="lg" iconRight={<ArrowRight className="h-5 w-5" aria-hidden />}>
                Skip the demo
              </LinkButton>
            </div>
            <p className="text-caption text-text-dim">
              Runs in your browser — the replay never leaves your device.
            </p>
            <p className="text-caption"><Link href="/try#home-replay-demo" className="inline-flex min-h-11 items-center font-semibold text-accent underline">How this works</Link></p>
            <PrivateTryLink />
          </div>

          <div><ReplayDropPreview onActivate={() => { warm(); inputRef.current?.click(); }} /><p className="mt-2 text-caption text-text-muted">Drag a replay here or click to choose</p></div>
        </div>
        {intakeMessage ? <p role="alert" className="px-6 pb-4 text-caption text-text-muted">{intakeMessage}</p> : null}
        {dossier && !editorOpen ? <section ref={playerChoices} aria-label="Parsed replay build orders" className="space-y-2 border-t border-border p-6">
          <p className="text-caption text-text-muted">Replay ready. Open either player&apos;s build order; switching sides does not analyze the replay again.</p>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">{dossier.players.map((player, index) => <Button key={player.handle ?? index} data-player-index={index} variant="secondary" className="min-h-11 min-w-0 whitespace-normal [overflow-wrap:anywhere]" onClick={() => { setPerspective(index as 0 | 1); setEditorOpen(true); }}>
            {player.name} · {player.race}
          </Button>)}</div>
        </section> : null}
      </Card>
      <SampleReportButton mobileOnly />

      <Modal
        open={statusOpen}
        onClose={closeStatus}
        footer={error && !busy ? <Button onClick={() => inputRef.current?.click()}>Choose another replay</Button> : undefined}
        size="lg"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-h4 font-semibold text-text">
              {busy ? "Parsing replay…" : "Replay preview"}
            </span>
            {filename ? (
              <Badge variant="cyan" size="sm">
                {filename.length > 36
                  ? `${filename.slice(0, 33)}…`
                  : filename}
              </Badge>
            ) : null}
          </span>
        }
        description={
          busy
            ? "Reading your replay in your browser…"
            : error
              ? "Something didn't work."
              : "Pick a replay above to see it parsed live."
        }
      >
        {busy ? (
          <div><p className="text-caption text-text-muted">{filename} · {replayDemoFileSize(fileSize)}</p><DossierLoading /></div>
        ) : error ? (
          <DossierError error={error} headingRef={errorRef} />
        ) : (
          <DossierLoading />
        )}
      </Modal>

      {browserIntent ? <ReplayDemoBrowserIsland request={browserRequest} onSuccess={browserSuccess} onBusy={browserBusy} onClose={closeStatus} onChooseAnother={chooseAnother} /> : null}

      <BuildEditorModal
        key={`${dossier?.game_id ?? "empty"}:${perspective}`}
        open={editorOpen && !!dossier}
        onClose={() => setEditorOpen(false)}
        events={editorEvents}
        gameId={dossier?.game_id}
        race={editorRace}
        vsRace={editorVsRace}
        perspective="you"
        defaultName={defaultBuildName(me, opp)}
        demoMode
      />

    </section>
  );
}

/* ---------------- Demo helpers ---------------- */

function coerceRace(r: string | undefined): RaceLite {
  if (r === "Protoss" || r === "Terran" || r === "Zerg" || r === "Random") {
    return r;
  }
  return "Random";
}

function coerceVsRace(r: string | undefined): VsRaceLite {
  if (
    r === "Protoss" ||
    r === "Terran" ||
    r === "Zerg" ||
    r === "Random" ||
    r === "Any"
  ) {
    return r;
  }
  return "Any";
}

function defaultBuildName(
  me: PreviewPlayer | null,
  opp: PreviewPlayer | null,
): string | undefined {
  if (!me || !opp) return undefined;
  const a = me.race?.charAt(0).toUpperCase() || "?";
  const b = opp.race?.charAt(0).toUpperCase() || "?";
  return `${a}v${b} — Custom`;
}

function DossierLoading() {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-text-muted">
      <Loader2 className="h-5 w-5 animate-spin text-accent-cyan" aria-hidden />
      <span className="text-body">Parsing replay…</span>
    </div>
  );
}

function DossierError({ error, headingRef }: { error: PreviewError; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const friendly = FRIENDLY_ERRORS[error.code];
  return (
    <div className="space-y-4 py-4">
      <div className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 text-body text-danger">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
        <div className="space-y-1">
          <h2 ref={headingRef} tabIndex={-1} role="alert" className="font-medium focus:outline-none">Couldn&apos;t parse that replay</h2>
          <p className="text-text-muted">{friendly}</p>
        </div>
      </div>
      {/sign up|agent/i.test(friendly) ? <p className="text-caption text-text-muted"><Link href="/sign-up" className="inline-flex min-h-11 items-center rounded-full border border-border px-4 font-semibold text-accent">Create a free account</Link></p> : null}
    </div>
  );
}

function ReplayDropPreview({ onActivate }: { onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label="Choose a replay file to preview"
      className="group relative flex aspect-[4/3] w-full flex-col items-center justify-center gap-4 overflow-hidden rounded-md border border-dashed border-accent-cyan/40 bg-bg-elevated/40 p-6 text-center transition-colors hover:border-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--halo-cyan) 0%, transparent 70%)",
        }}
      />
      <span
        aria-hidden
        className="relative flex h-16 w-16 items-center justify-center rounded-md border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan motion-safe:transition-transform motion-safe:duration-200 group-hover:scale-110"
      >
        <FileUp className="h-8 w-8" />
      </span>
      <span className="relative space-y-1">
        <span className="block text-h4 font-semibold text-text">
          Pick a replay
        </span>
        <span className="block text-caption text-text-muted">
          .SC2Replay · parsed locally, never uploaded
        </span>
      </span>
    </button>
  );
}
