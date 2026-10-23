"use client";

import { useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { useToastOptional } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";

export interface OwnerBuildPublication { published: boolean; publicSlug: string | null; mirrorPending: boolean }

export function publicationError(error: unknown): string {
  if (!error || typeof error !== "object") return "Try again in a moment.";
  const message = "message" in error ? String(error.message) : "Try again in a moment.";
  const id = "requestId" in error && error.requestId ? ` Error ID: ${String(error.requestId)}` : "";
  return `${message}${id}`;
}

/** The menu reads publication identity only when opened on a public build. */
export function useBuildPublicationActions({ slug, name, enabled, onChanged, publicationOverride }: { slug: string; name: string; enabled: boolean; onChanged?: () => void | Promise<unknown>; publicationOverride?: OwnerBuildPublication | null }) {
  const { getToken } = useAuth();
  const toast = useToastOptional()?.toast;
  const [confirm, setConfirm] = useState(false);
  const publication = useApi<OwnerBuildPublication>((enabled || confirm) && !publicationOverride ? `/v1/community/my-build-publication/${encodeURIComponent(slug)}` : null);
  const [pending, setPending] = useState(false);
  const [copyValue, setCopyValue] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const copyRef = useRef<HTMLInputElement>(null);
  const current = publicationOverride ?? publication.data;
  const publicSlug = current?.published ? current.publicSlug : null;
  const notifyError = (title: string, error: unknown) => {
    const detail = publicationError(error);
    if (toast) toast.error(title, { description: detail });
    else setMessage(`${title}. ${detail}`);
  };
  const copy = async (targetSlug: string | null = publicSlug) => {
    if (!targetSlug) return;
    const url = `${window.location.origin}/community/builds/${encodeURIComponent(targetSlug)}`;
    try { await navigator.clipboard.writeText(url); if (toast) toast.success("Link copied"); else setMessage("Link copied"); }
    catch { setCopyValue(url); }
  };
  const unpublish = async () => {
    if (!publicSlug || pending) return;
    setPending(true); setMessage("");
    try {
      await apiCall(getToken, `/v1/community/builds/${encodeURIComponent(publicSlug)}`, { method: "DELETE" });
      // The authoritative owner read repairs an interrupted private visibility mirror.
      let syncWarning = "";
      const repaired = await apiCall<OwnerBuildPublication>(getToken, `/v1/community/my-build-publication/${encodeURIComponent(slug)}`).catch((error: unknown) => {
        syncWarning = `The listing is unpublished, but its private badge couldn't refresh. Reopen this menu to retry. ${publicationError(error)}`;
        return { published: false, publicSlug: null, mirrorPending: true };
      });
      await Promise.resolve(publication.mutate(repaired, { revalidate: false })).catch(() => undefined);
      try { await onChanged?.(); } catch { syncWarning ||= "The listing is unpublished. Refresh your library to update its private badge."; }
      setConfirm(false);
      if (toast) toast.success("Unpublished."); else setMessage("Unpublished.");
      if (syncWarning || repaired.mirrorPending) {
        const warning = syncWarning || "The listing is unpublished. Your private Published badge is still syncing; reopen this menu to retry.";
        if (toast) toast.warning("Listing removed; private badge still syncing", { description: warning }); else setMessage(warning);
      }
    } catch (error) { notifyError("Couldn't unpublish build", error); }
    finally { setPending(false); }
  };
  return {
    publication, publicSlug, copy, requestUnpublish: () => setConfirm(true),
    dialogs: <>
      <ConfirmDialog open={confirm} title={`Unpublish “${name}”?`} description="It disappears from Community builds. Your private copy, stats and notes stay." confirmLabel="Unpublish" intent="danger" focusCancel loading={pending} onClose={() => { if (!pending) setConfirm(false); }} onConfirm={unpublish} />
      <Modal open={copyValue != null} onClose={() => setCopyValue(null)} title="Copy public link" initialFocusRef={copyRef}><input ref={copyRef} readOnly aria-label="Public build link" value={copyValue ?? ""} onFocus={(event) => event.currentTarget.select()} className="min-h-11 w-full rounded border border-border bg-bg-elevated px-3 text-caption text-text" /><p className="mt-2 text-caption text-text-muted">Copy the selected link to share this listing.</p></Modal>
      {message ? <p role="status" className="mt-2 break-words text-caption text-text-muted">{message}</p> : null}
    </>,
  };
}
