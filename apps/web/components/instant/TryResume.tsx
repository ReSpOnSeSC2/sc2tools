"use client";

/**
 * Saving /try games to an account — the "Save these games to your free
 * account" card, the upload hook behind it, and the `?resume=1` hand-off.
 *
 *   signed out → sign-up / sign-in links that come back to `/try?resume=1`
 *                (the only post-auth redirect the auth pages accept);
 *   signed in  → a button that uploads the games analysed here;
 *   `?resume=1` + signed in → the games stored on this device are loaded
 *                (never re-parsed) and uploaded straight away.
 *
 * On success the stored games are forgotten and the visitor lands on
 * /app. A stopped upload says why: today's cap (games stay on the device
 * until they expire; the card says when uploads resume), an expired
 * sign-in, or a busy server (retry). Each stored game is uploaded with
 * the engine version that parsed it, not the one deployed now.
 *
 * Example:
 *   const upload = useTryUpload();
 *   <Suspense fallback={null}><TryResume upload={upload} games={games} onResume={() => setResumeMode(true)} /></Suspense>
 *   <SaveGamesCta upload={upload} games={games} />
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { CloudUpload } from "lucide-react";
import { Button } from "@/components/ui";
import { API_BASE } from "@/lib/clientApi";
import { trackInstantError, trackInstantSignupClick, trackInstantUploadDone } from "@/lib/instant/analytics";
import { TRY_SIGN_IN_HREF, TRY_SIGN_UP_HREF } from "@/lib/instant/authRedirect";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { clearTryData, loadTryGames } from "@/lib/instant/localStore";
import type { UploadableGame } from "@/lib/instant/types";
import { uploadGames, type UploadProgress, type UploadSummary } from "@/lib/instant/uploader";
import { TryUploadStatus } from "./report/TryUploadStatus";

/** Why a save stopped short ("rejected": the server accepted none of the games). */
export type TryUploadStop = "daily_cap" | "auth" | "server" | "rejected";

export type TryUploadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty"; reason: "none" | "storage" }
  | { status: "uploading"; progress: UploadProgress | null }
  | { status: "done"; accepted: number }
  | {
      status: "stopped";
      reason: TryUploadStop;
      accepted: number;
      pending: number;
      /** Daily cap only: epoch ms when uploads resume (null when unknown). */
      resetAt?: number | null;
    };

export interface TryUpload {
  state: TryUploadState;
  /** Upload these games (the signed-in "Save" button). */
  run(games: ReadonlyArray<UploadableGame>): Promise<void>;
  /** Load the games stored on this device and upload them (`?resume=1`). */
  resume(): Promise<void>;
  /** Upload the last set of games again (after a busy server). */
  retry(): Promise<void>;
}

const IDLE: TryUploadState = { status: "idle" };
const DASHBOARD_PATH = "/app";

/**
 * Map an upload summary to what the card shows. `null` = the run was
 * aborted (the page went away); success = no stop and every game is now
 * in the account (accepted, or already there).
 *
 * Example:
 *   classifyUpload({ accepted: [a], rejected: [], skippedExisting: [], oversized: [], pending: [] });
 *   // -> { status: "done", accepted: 1 }
 */
export function classifyUpload(summary: UploadSummary): TryUploadState | null {
  const accepted = summary.accepted.length;
  if (summary.stoppedReason === "aborted") return null;
  if (summary.stoppedReason === "daily_cap") {
    const resetAt = summary.dailyCap?.resetAt ?? null;
    return { status: "stopped", reason: "daily_cap", accepted, pending: summary.pending.length, resetAt };
  }
  if (summary.stoppedReason) {
    return { status: "stopped", reason: summary.stoppedReason, accepted, pending: summary.pending.length };
  }
  if (accepted + summary.skippedExisting.length === 0) {
    const pending = summary.rejected.length + summary.oversized.length;
    return { status: "stopped", reason: "rejected", accepted, pending };
  }
  return { status: "done", accepted };
}

/**
 * Only the id + payload leave the device (never the replay file), tagged
 * with the engine version that parsed each game when it is known.
 */
function uploadable(games: ReadonlyArray<UploadableGame>): UploadableGame[] {
  return games.map(({ gameId, json, engineVersion }) => (engineVersion ? { gameId, json, engineVersion } : { gameId, json }));
}

/** Mutable bookkeeping shared by the upload actions of one `useTryUpload`. */
interface UploadRuntime {
  /** False once the page unmounted (late results are dropped). */
  alive: boolean;
  /** True while an upload or resume runs (one at a time). */
  busy: boolean;
  controller: AbortController | null;
  /** The games of the latest upload (Retry sends them again). */
  lastGames: UploadableGame[];
}

type SetUploadState = (state: TryUploadState) => void;

/** One stable runtime record per hook; the upload is aborted when the page unmounts. */
function useUploadRuntime(): UploadRuntime {
  const runtime = useRef<UploadRuntime>({ alive: false, busy: false, controller: null, lastGames: [] }).current;
  useEffect(() => {
    runtime.alive = true;
    return () => {
      runtime.alive = false;
      runtime.controller?.abort();
    };
  }, [runtime]);
  return runtime;
}

/**
 * Upload `games` and turn the summary into card state; on success forget
 * the games stored on this device and open /app.
 *
 * Example:
 *   const perform = useUploadAction(runtime, setState);
 *   await perform([{ gameId, json }]);
 */
function useUploadAction(runtime: UploadRuntime, setState: SetUploadState): (games: UploadableGame[]) => Promise<void> {
  const { getToken } = useAuth();
  const router = useRouter();
  return useCallback(
    async (games: UploadableGame[]): Promise<void> => {
      runtime.lastGames = games;
      const abort = new AbortController();
      runtime.controller = abort;
      setState({ status: "uploading", progress: null });
      const summary = await uploadGames(games, {
        getToken,
        apiBase: API_BASE,
        engineVersion: INSTANT_ENGINE_VERSION,
        signal: abort.signal,
        onProgress: (progress) => {
          if (runtime.alive) setState({ status: "uploading", progress });
        },
      });
      const next = classifyUpload(summary);
      if (!runtime.alive) return;
      setState(next ?? IDLE);
      if (next?.status === "stopped" && next.reason !== "rejected") trackInstantError({ kind: `upload_${next.reason}` });
      if (next?.status !== "done") return;
      trackInstantUploadDone({ games: next.accepted });
      await clearTryData().catch(() => undefined); // best effort: they expire anyway
      router.push(DASHBOARD_PATH);
    },
    [getToken, router, runtime, setState],
  );
}

/**
 * Upload state + actions shared by the save card and the resume flow.
 * One upload at a time; the upload is aborted when the page unmounts.
 *
 * Example:
 *   const upload = useTryUpload();
 *   <Button onClick={() => void upload.run(games)}>Save</Button>
 */
export function useTryUpload(): TryUpload {
  const [state, setState] = useState<TryUploadState>(IDLE);
  const runtime = useUploadRuntime();
  const perform = useUploadAction(runtime, setState);

  const guarded = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      if (runtime.busy) return;
      runtime.busy = true;
      try {
        await task();
      } catch {
        // uploadGames never throws for HTTP/network problems; anything else is a bug surfaced as "server".
        if (runtime.alive) setState({ status: "stopped", reason: "server", accepted: 0, pending: runtime.lastGames.length });
      } finally {
        runtime.busy = false;
      }
    },
    [runtime],
  );

  const run = useCallback(
    (games: ReadonlyArray<UploadableGame>) => guarded(() => (games.length > 0 ? perform(uploadable(games)) : Promise.resolve())),
    [guarded, perform],
  );

  const resume = useCallback(
    () =>
      guarded(async () => {
        setState({ status: "loading" });
        const stored = await loadTryGames(Date.now()).catch(() => null);
        if (!runtime.alive) return;
        if (stored === null || stored.length === 0) {
          setState({ status: "empty", reason: stored === null ? "storage" : "none" });
          return;
        }
        await perform(uploadable(stored));
      }),
    [guarded, perform, runtime],
  );

  const retry = useCallback(() => run(runtime.lastGames), [run, runtime]);
  return { state, run, resume, retry };
}

const LINK_CLASS =
  "font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function SignedOutActions() {
  return (
    <div className="space-y-2">
      <Link
        href={TRY_SIGN_UP_HREF}
        onClick={() => trackInstantSignupClick()}
        className={[
          "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border-2 border-line bg-accent px-5",
          "font-semibold text-white hard-press hover:brightness-95",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        ].join(" ")}
      >
        Create a free account
      </Link>
      <p className="text-caption text-text-muted">
        Already have an account?{" "}
        <Link href={TRY_SIGN_IN_HREF} className={["inline-flex min-h-[44px] items-center", LINK_CLASS].join(" ")}>
          Sign in
        </Link>
      </p>
    </div>
  );
}

export interface SaveGamesCtaProps {
  upload: TryUpload;
  /** Games analysed on this page (from this device or this session). */
  games: ReadonlyArray<UploadableGame>;
  className?: string;
}

/**
 * "Save these games to your free account" (see module comment).
 *
 * Example:
 *   <SaveGamesCta upload={upload} games={games} />
 */
export function SaveGamesCta({ upload, games, className = "" }: SaveGamesCtaProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const headingId = useId();
  // "empty" = a resume found nothing stored; the games on screen can still be saved.
  const canStart = upload.state.status === "idle" || upload.state.status === "empty";
  const count = games.length;
  const noun = count === 1 ? "game" : "games";
  return (
    <section
      aria-labelledby={headingId}
      className={["space-y-3 rounded-xl border-2 border-accent bg-bg-surface p-4 shadow-hard sm:p-6", className].filter(Boolean).join(" ")}
    >
      <div className="flex items-start gap-3">
        <CloudUpload className="mt-1 h-6 w-6 flex-shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 id={headingId} className="font-display text-h3 text-text">
            Save these games to your free account
          </h2>
          <p className="text-body text-text-muted">
            Keep this report, open every analyzer tab and add new games any time. Saving sends the analysis of each
            game — never your replay files.
          </p>
        </div>
      </div>
      {/* Plain links until Clerk confirms a session, so the card still works if Clerk is slow or blocked. */}
      {isLoaded && isSignedIn ? (
        <div className="space-y-3">
          {canStart ? (
            <Button onClick={() => void upload.run(games)} disabled={count === 0}>
              Save {count} {noun} to my account
            </Button>
          ) : null}
          {/* Always mounted so the first "Saving…" update is announced; idle renders nothing. */}
          <TryUploadStatus state={canStart ? IDLE : upload.state} onRetry={() => void upload.retry()} />
        </div>
      ) : (
        <SignedOutActions />
      )}
    </section>
  );
}

export interface TryResumeProps {
  upload: TryUpload;
  games: ReadonlyArray<UploadableGame>;
  /** Called once when the page was opened with `?resume=1`. */
  onResume: () => void;
}

/**
 * The `?resume=1` hand-off after sign-up/sign-in (render inside Suspense:
 * it reads the search params). Signed in: uploads the stored games at
 * once and shows the save card with its progress (or the bare status
 * while the page has no games to show); signed out: shows the save card
 * again. Renders nothing without `?resume=1`.
 *
 * Example:
 *   <Suspense fallback={null}><TryResume upload={upload} games={games} onResume={markResume} /></Suspense>
 */
export function TryResume({ upload, games, onResume }: TryResumeProps) {
  const resume = useSearchParams().get("resume") === "1";
  const { isLoaded, isSignedIn } = useAuth();
  const { state, resume: start } = upload;
  useEffect(() => {
    if (resume) onResume();
  }, [resume, onResume]);
  useEffect(() => {
    if (resume && isLoaded && isSignedIn && state.status === "idle") void start();
  }, [resume, isLoaded, isSignedIn, state.status, start]);
  if (!resume) return null;
  // The card itself falls back to the sign-up links while Clerk loads (or is blocked).
  if (games.length > 0) return <SaveGamesCta upload={upload} games={games} />;
  if (!isLoaded || !isSignedIn) return null;
  return (
    <section aria-label="Saving your games" className="rounded-xl border-2 border-accent bg-bg-surface p-4 shadow-hard sm:p-6">
      <TryUploadStatus state={state} onRetry={() => void upload.retry()} />
    </section>
  );
}
