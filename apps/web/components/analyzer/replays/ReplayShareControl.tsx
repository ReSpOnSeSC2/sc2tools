"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Check, Copy, ExternalLink, Link2, LockKeyhole, RefreshCcw, Share2, ShieldCheck, Tv2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { useToast } from "@/components/ui/Toast";
import { apiCall, useApi, useOwnerRequestScope, type ClientApiError } from "@/lib/clientApi";
import { useCopy } from "@/lib/useCopy";
import type { ReplaySharingResponse } from "./types";

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const REQUEST_TIMEOUT_MS = 20_000;
type Origin = "outside" | "modal";
type Owner = { id: string | null; active: boolean };
type Snapshot = { enabled: boolean | null; handle: string | null; updatedAt: string | null };
type Resource = Snapshot & { owner: Owner; open: boolean };
type Intent = { owner: Owner; resource: Resource; controller: AbortController; active: boolean;
  phase: "write" | "handoff" | "copy"; sent: boolean; known: boolean; uncertain: boolean; expected: Snapshot | null };
type Refresh = { owner: Owner; visibility: object; controller: AbortController; active: boolean; initial: boolean;
  observed: ReplaySharingResponse | null; failed: boolean };
function snapshot(value: ReplaySharingResponse | undefined): Snapshot {
  return { enabled: typeof value?.enabled === "boolean" ? value.enabled : null,
    handle: typeof value?.handle === "string" ? value.handle : null,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null };
}
function matches(a: Snapshot, b: Snapshot) {
  return a.enabled === b.enabled && a.handle === b.handle && a.updatedAt === b.updatedAt;
}
function validSharing(value: unknown): value is ReplaySharingResponse {
  if (!value || typeof value !== "object" || !("enabled" in value) || !("handle" in value)) return false;
  return typeof value.enabled === "boolean" && (value.handle === null || typeof value.handle === "string")
    && (!value.enabled || typeof value.handle === "string" && value.handle.length > 0);
}
const retired = () => new DOMException("This replay-sharing action is no longer current.", "AbortError");
const isAbort = (error: unknown) => !!error && typeof error === "object" && "name" in error && error.name === "AbortError";

/** Explicit consent and copying remain separate, admitted operations. */
export function ReplayShareControl() {
  const auth = useAuth(), ownerId = auth.isLoaded && auth.isSignedIn && auth.userId ? auth.userId : null;
  // SWR revalidateOnMount does not suppress automatic reads on a key change.
  // A fresh owner instance keeps its one explicit initial read authoritative.
  return <OwnerReplayShareControl key={ownerId ?? "signed-out"} ownerId={ownerId} getToken={auth.getToken} />;
}

function OwnerReplayShareControl({ ownerId, getToken }: { ownerId: string | null; getToken: () => Promise<string | null> }) {
  const runOwned = useOwnerRequestScope(ownerId, getToken);
  const { toast } = useToast();
  const sharingReq = useApi<ReplaySharingResponse>("/v1/me/replay-sharing",
    { revalidateOnFocus: false, revalidateOnMount: false, revalidateOnReconnect: false, shouldRetryOnError: false,
      onSuccess: data => {
        const read = refreshOperation.current;
        if (read?.active && read.owner === ownerRef.current && read.owner.active
          && (read.initial || read.visibility === visibilityRef.current)) {
          read.observed = validSharing(data) ? data : null; read.failed = !validSharing(data);
        }
      },
      onError: () => {
        const read = refreshOperation.current;
        if (read?.active && read.owner === ownerRef.current && read.owner.active
          && (read.initial || read.visibility === visibilityRef.current)) read.failed = true;
      },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
  const [open, setOpen] = useState(false);
  const owner = useMemo<Owner>(() => ({ id: ownerId, active: false }), [ownerId]);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const visibility = useMemo(() => ({ owner, open }), [owner, open]);
  const visibilityRef = useRef(visibility); visibilityRef.current = visibility;
  const unknownRef = useRef<Owner | null>(null), [unknownOwner, setUnknownOwner] = useState<Owner | null>(null);
  const [initialRead, setInitialRead] = useState<{ owner: Owner; status: "loading" | "error" | "ready" } | null>(null);
  const [refreshOnOpen, setRefreshOnOpen] = useState<{ owner: Owner } | null>(null);
  const operation = useRef<Intent | null>(null), [jobState, setJobState] = useState<Intent | null>(null);
  const refreshOperation = useRef<Refresh | null>(null), [readState, setReadState] = useState<Refresh | null>(null);
  const [handoff, setHandoff] = useState<{ job: Intent; value: ReplaySharingResponse } | null>(null);
  const outsideCopy = useRef<HTMLButtonElement>(null), modalCopy = useRef<HTMLButtonElement>(null);
  const recoveryOrigin = useRef<Origin>("outside");
  const sharing = sharingReq.data, value = snapshot(sharing);
  const resource = useMemo<Resource>(() => ({ owner, open, enabled: value.enabled, handle: value.handle, updatedAt: value.updatedAt }),
    [owner, open, value.enabled, value.handle, value.updatedAt]);
  const resourceRef = useRef(resource);
  if (resourceRef.current !== resource) {
    const previous = resourceRef.current, job = operation.current;
    if (job?.active && job.resource === previous) {
      if (job.expected && resource.owner === previous.owner && resource.open === previous.open && matches(resource, job.expected)) {
        // Only this acknowledged write may move its intent to the new snapshot.
        job.resource = resource; job.expected = null;
      } else {
        job.active = false; job.uncertain ||= job.phase === "write" && job.sent && !job.known;
      }
    }
    resourceRef.current = resource;
  }
  const current = useCallback((job: Intent | null): job is Intent => !!job && job.active
    && operation.current === job && ownerRef.current === job.owner && job.owner.active
    && resourceRef.current === job.resource, []);
  const markUnknown = useCallback((job: Intent) => {
    if (job.sent && !job.known && ownerRef.current === job.owner && job.owner.active) {
      unknownRef.current = job.owner; setUnknownOwner(job.owner);
    }
  }, []);
  const initialReady = initialRead?.owner === owner && initialRead.status === "ready";
  const initialFailed = initialRead?.owner === owner && initialRead.status === "error";
  const uncertainWrite = unknownOwner === owner || unknownRef.current === owner
    || operation.current?.owner === owner && operation.current.uncertain;
  const unknown = initialFailed || uncertainWrite;
  const refreshing = !!readState?.active && readState.owner === owner && (readState.initial || readState.visibility === visibility);
  const loadingStatus = !!ownerId && !initialReady && !initialFailed || sharingReq.isLoading || sharingReq.isValidating || refreshing;
  const saving = !!jobState && current(jobState) && jobState.phase === "write";
  const handle = sharing?.enabled && typeof sharing.handle === "string" && sharing.handle ? sharing.handle : null;
  const path = handle ? "/players/" + encodeURIComponent(handle) + "/replays" : null;
  const copyAllowed = !unknown && !loadingStatus && !sharingReq.error && !sharingReq.isPreviousData && !!handle;
  const clipboard = useCopy({ scopeKey: resource, onCopied: () => {
    const job = operation.current;
    if (current(job) && job.phase === "copy" && unknownRef.current !== owner) toast.success("Replay page link copied");
  } });
  const copying = clipboard.pending, copied = clipboard.copied, copy = clipboard.copy;
  const finish = useCallback((job: Intent) => {
    job.active = false;
    if (operation.current !== job) return;
    operation.current = null;
    if (ownerRef.current === job.owner && job.owner.active) { setJobState(null); setHandoff(null); }
  }, []);
  function retireCurrent() {
    const job = operation.current;
    if (job) { markUnknown(job); job.active = false; operation.current = null; job.controller.abort(); }
    setJobState(null); setHandoff(null); clipboard.clear();
  }
  useClientLayoutEffect(() => {
    owner.active = !!owner.id;
    // This control can also be mounted independently of ReplayLibrary's owner
    // key. A new account starts from its own initial settings read.
    setOpen(false); unknownRef.current = null; setUnknownOwner(null);
    setJobState(null); setHandoff(null); setReadState(null); setRefreshOnOpen(null);
    return () => {
      owner.active = false;
      queueMicrotask(() => {
        if (owner.active) return;
        const job = operation.current;
        if (job?.owner === owner) { job.active = false; job.controller.abort(); }
        const read = refreshOperation.current;
        if (read?.owner === owner) { read.active = false; read.controller.abort(); }
      });
    };
  }, [owner]);
  useClientLayoutEffect(() => {
    const job = operation.current;
    if (job && !job.active) { markUnknown(job); job.controller.abort(); operation.current = null; setJobState(null); setHandoff(null); }
    const read = refreshOperation.current;
    if (read && (read.owner !== owner || !read.initial && read.visibility !== visibility)) {
      read.active = false; read.controller.abort(); refreshOperation.current = null; setReadState(null);
    }
  }, [resource, owner, visibility, markUnknown]);
  function begin(phase: Intent["phase"], origin: Origin): Intent | null {
    if (!owner.id || !owner.active || ownerRef.current !== owner || resourceRef.current !== resource
      || unknown || loadingStatus || sharingReq.error || sharingReq.isPreviousData || !validSharing(sharing) || saving) return null;
    retireCurrent();
    const job: Intent = { owner, resource, controller: new AbortController(), active: true, phase,
      sent: false, known: false, uncertain: false, expected: null };
    recoveryOrigin.current = origin; operation.current = job; setJobState(job);
    return job;
  }
  async function copyLink(origin: Origin) {
    if (!copyAllowed || !handle || copying) return;
    const job = begin("copy", origin); if (!job) return;
    try { await clipboard.copy(window.location.origin + "/players/" + encodeURIComponent(handle) + "/replays"); }
    finally { finish(job); }
  }
  async function setEnabled(enabled: boolean, copyAfter = false) {
    const job = begin("write", "modal"), requestOwner = owner.id; if (!job || !requestOwner) return;
    let queued = false;
    const assertIntent = () => { if (!current(job)) throw retired(); };
    try {
      const next = await runOwned(requestOwner, async (scopedToken, signal, assertOwner) => {
        const token = await scopedToken(); assertIntent();
        job.sent = true;
        const result = await apiCall<ReplaySharingResponse>(() => Promise.resolve(token), "/v1/me/replay-sharing",
          { method: "PUT", body: JSON.stringify({ enabled }), signal });
        assertOwner(); assertIntent();
        if (!validSharing(result) || result.enabled !== enabled) throw new Error("Sharing status could not be confirmed.");
        job.expected = snapshot(result);
        await sharingReq.mutate(() => {
          assertOwner(); assertIntent();
          return result;
        }, { revalidate: false });
        assertOwner(); assertIntent(); job.known = true;
        return result;
      }, REQUEST_TIMEOUT_MS, job.controller.signal);
      assertIntent();
      if (copyAfter && next.enabled && next.handle) {
        // A one-shot explicit intent is consumed by the newly committed copy scope.
        // The current sharing state/copy outcome confirms this combined action;
        // a global live toast would cover the phone recovery dialog's footer.
        job.phase = "handoff"; queued = true; setHandoff({ job, value: next });
      } else toast.success(enabled ? "Public replay page is live" : "Public replay page turned off");
    } catch (error) {
      markUnknown(job);
      if (current(job) && !isAbort(error)) toast.error("Couldn't update replay sharing",
        { description: (error as ClientApiError)?.message || "Please try again." });
    } finally { if (!queued) finish(job); }
  }
  useEffect(() => {
    if (!handoff || !current(handoff.job) || handoff.job.phase !== "handoff" || !copyAllowed
      || !matches(resource, snapshot(handoff.value)) || !handoff.value.handle) return;
    const job = handoff.job; job.phase = "copy"; setHandoff(null);
    void copy(window.location.origin + "/players/" + encodeURIComponent(handoff.value.handle) + "/replays")
      .finally(() => finish(job));
  }, [handoff, resource, copyAllowed, copy, current, finish]);
  async function enableAndCopy() {
    if (sharing?.enabled && handle) await copyLink("modal");
    else await setEnabled(true, true);
  }
  const refreshLatest = useRef<(initial?: boolean) => Promise<void>>(async () => {});
  refreshLatest.current = async (initial = false) => {
    if (!owner.id || !owner.active || !initial && (!open || visibilityRef.current !== visibility) || refreshOperation.current?.active) return;
    const read: Refresh = { owner, visibility, controller: new AbortController(), active: true, initial, observed: null, failed: false };
    refreshOperation.current = read; setReadState(read);
    if (initial) setInitialRead({ owner, status: "loading" });
    const assertRead = () => {
      if (!read.active || refreshOperation.current !== read || ownerRef.current !== owner || !owner.active
        || !read.initial && visibilityRef.current !== visibility) throw retired();
    };
    try {
      await runOwned(owner.id, async (_token, _signal, assertOwner) => {
        const next = await sharingReq.mutate();
        assertOwner(); assertRead();
        // SWR can return its previous data after a failed revalidation. Only
        // this generation's observed successful GET admits that cached value.
        if (read.failed || !read.observed || !validSharing(next) || !matches(snapshot(next), snapshot(read.observed))) {
          throw new Error("Sharing status could not be confirmed.");
        }
        unknownRef.current = null; setUnknownOwner(null); setInitialRead({ owner, status: "ready" });
      }, REQUEST_TIMEOUT_MS, read.controller.signal);
    } catch (error) {
      if (read.active && ownerRef.current === owner && owner.active && (read.initial || visibilityRef.current === visibility) && !isAbort(error)) {
        if (read.initial) setInitialRead({ owner, status: "error" });
        else toast.error("Couldn't check replay sharing", { description: (error as ClientApiError)?.message || "Please try again." });
      }
    } finally {
      if (refreshOperation.current === read) {
        refreshOperation.current = null; read.active = false;
        if (ownerRef.current === owner && owner.active && (read.initial || visibilityRef.current === visibility)) setReadState(null);
      }
    }
  };
  useEffect(() => {
    // Bound mutate forces a new GET, unlike SWR's deduped mount revalidation.
    // This replaces that mount read, so warm same-owner remounts stay honest.
    void refreshLatest.current(true);
  }, [owner]);
  useEffect(() => {
    if (!refreshOnOpen || refreshOnOpen.owner !== owner || !open) return;
    setRefreshOnOpen(null); void refreshLatest.current();
  }, [refreshOnOpen, owner, open]);
  function openSharing() {
    if (resourceRef.current !== resource || !owner.active) return;
    retireCurrent(); setOpen(true);
    if (unknownRef.current === owner || unknown) setRefreshOnOpen({ owner });
  }
  function closeSharing() {
    if (resourceRef.current !== resource) return;
    retireCurrent(); setRefreshOnOpen(null);
    const read = refreshOperation.current;
    if (read && !read.initial) { read.active = false; read.controller.abort(); refreshOperation.current = null; setReadState(null); }
    setOpen(false);
  }
  const recoveryInside = open && recoveryOrigin.current === "modal";
  const recovery = <CopyRecoveryDialog text={unknown ? null : clipboard.fallbackText} inputRef={clipboard.inputRef}
    triggerRef={recoveryOrigin.current === "modal" ? modalCopy : outsideCopy} scopeKey={resource}
    onDismiss={clipboard.clear} title="Copy replay page link manually" label="Copy replay page link manually" />;

  return (
    <>
      <div
        className="flex w-full shrink-0 flex-col gap-2 sm:w-auto"
        role="group"
        aria-label="Replay sharing actions"
      >
        <Button
          variant={unknown || sharing?.enabled && handle ? "secondary" : "primary"}
          onClick={openSharing}
          disabled={saving}
          iconLeft={unknown || loadingStatus ? <RefreshCcw className="h-4 w-4" aria-hidden /> : sharing?.enabled && handle ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Share2 className="h-4 w-4" aria-hidden />}
          className="w-full"
        >
          {unknown ? "Check sharing status" : loadingStatus ? "Checking sharing…" : sharing?.enabled && handle ? "Sharing on" : "Share"}
        </Button>
        {copyAllowed ? (
          <Button
            ref={outsideCopy}
            variant="ghost"
            onClick={() => void copyLink("outside")}
            loading={copying}
            disabled={saving}
            iconLeft={copied ? <Check className="h-4 w-4 text-success" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            className="w-full"
            aria-label="Copy public replay page link"
          >
            <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
          </Button>
        ) : null}
      </div>
      <Modal
        open={open}
        onClose={closeSharing}
        title="Share your replay archive"
        description="A private-by-default player page for teammates, coaches and viewers."
        size="md"
        footer={
          unknown ? (<><Button variant="ghost" size="sm" onClick={closeSharing}>Close</Button><Button variant="secondary" size="sm" onClick={() => void refreshLatest.current()} loading={refreshing}>Check sharing status</Button></>) : loadingStatus ? (
            <Button variant="ghost" size="sm" onClick={closeSharing}>Close</Button>
          ) : sharingReq.error ? (
            <>
              <Button variant="ghost" size="sm" onClick={closeSharing}>Close</Button>
              <Button variant="secondary" size="sm" onClick={() => void refreshLatest.current()} iconLeft={<RefreshCcw className="h-4 w-4" aria-hidden />}>Try again</Button>
            </>
          ) : sharing?.enabled && handle ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void setEnabled(false)} loading={saving}>Turn off sharing</Button>
              <Button ref={modalCopy} size="sm" onClick={() => void copyLink("modal")} loading={copying} iconLeft={copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : (
            <Button ref={modalCopy} size="sm" onClick={() => void enableAndCopy()} loading={saving} iconLeft={<Link2 className="h-4 w-4" aria-hidden />}>
              Turn on and copy link
            </Button>
          )
        }
      >
        {unknown ? (<p role="status" className="rounded-lg border border-border bg-bg-elevated p-3 text-caption text-text">{refreshing ? "Checking current sharing status…" : uncertainWrite ? "Sharing status needs to be checked. An earlier change may have completed. Check the current status before copying or changing sharing." : "Sharing status could not be loaded. Check the current status before copying or changing sharing."}</p>) : loadingStatus ? (
          <div aria-busy="true"><Skeleton rows={3} /></div>
        ) : sharingReq.error ? (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-caption text-danger">Sharing settings could not be loaded. Try the request again or close this dialog.</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border-2 border-line bg-bg-elevated/45 p-4">
              <div className="flex items-start gap-3">
                {sharing?.enabled && handle ? <Tv2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden /> : <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-text-muted" aria-hidden />}
                <div className="min-w-0">
                  <p className="font-semibold text-text">{sharing?.enabled && handle ? "Your player replay page is public" : "Your replay archive is private"}</p>
                  <p className="mt-1 break-all font-mono text-micro text-text-muted">{path || "Your personal player replay address is created when you turn sharing on."}</p>
                  {path ? (
                    <Link href={path} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md text-caption font-semibold text-accent-cyan hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                      Preview public page <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-caption font-semibold text-text"><ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden /> Exactly what visitors can see</h3>
              <p className="text-caption leading-relaxed text-text-muted">
                Turning this on shares every synced replay in this archive—not only games visible under your current dashboard filters. Anyone can see replay dates, maps, results, player display names and races, game-time MMR, detected builds and strategies, macro scores, matched Twitch or YouTube VOD links, and download archived original replay files. Replay Analysis and the full Macro breakdown require the visitor to sign in to SC2 Tools.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                An original .SC2Replay can contain player/account identifiers, chat, team information, and other data Blizzard embeds in the file. Starting a download also gives that visitor a temporary storage URL, which can reveal the storage host and object path until it expires in about one minute.
              </p>
              <p className="text-caption leading-relaxed text-text-muted">
                Turn sharing off at any time to disable the page, analysis access and new downloads. Your player replay address stays assigned to you and becomes available again if you re-enable sharing. A download URL already issued before sharing is disabled can continue working until its one-minute expiry.
              </p>
            </div>
          </div>
        )}
        {recoveryInside ? recovery : null}
      </Modal>
      {!recoveryInside ? recovery : null}
    </>
  );
}
