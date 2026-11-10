"use client";

import { useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Copy, Link2, LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { useToastOptional } from "@/components/ui/Toast";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { fmtDate } from "@/lib/format";
import { gameSharesPath, shareApiPath, shareLinkUrl, type GameShare, type GameShareList } from "@/lib/gameShares";
import { useCopy } from "@/lib/useCopy";

/**
 * Manage one game's share links: the live link (copy, views, turn off) and
 * the ones already turned off. Turning a link off ends access at once;
 * a new link for the same game gets a new address.
 */
export function ShareLinksDialog({ gameId, open, onClose }: { gameId: string; open: boolean; onClose: () => void }) {
  const { getToken } = useAuth();
  const toast = useToastOptional()?.toast;
  const list = useApi<GameShareList>(open ? gameSharesPath(gameId) : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  const [pending, setPending] = useState<string | null>(null);
  const [scope] = useState(() => ({ gameId }));
  const copier = useCopy({ scopeKey: scope, onCopied: () => toast?.success("Link copied") });
  const copyButton = useRef<HTMLButtonElement>(null);
  const shares = list.data?.shares ?? [];
  const live = shares.filter((share) => share.active);
  const retired = shares.filter((share) => !share.active);

  const run = async (key: string, action: () => Promise<unknown>, failure: string) => {
    setPending(key);
    try {
      await action();
      await list.mutate();
    } catch (error) {
      toast?.error(failure, { description: (error as ClientApiError)?.message || "Please try again." });
    } finally {
      setPending(null);
    }
  };
  const create = () => run("create", async () => {
    const out = await apiCall<{ share: GameShare }>(getToken, gameSharesPath(gameId), { method: "POST", body: "{}" });
    await copier.copy(shareLinkUrl(out.share.token, window.location.origin));
  }, "Couldn't create a share link");
  const revoke = (share: GameShare) => run(share.token, async () => {
    await apiCall(getToken, shareApiPath(share.token), { method: "DELETE" });
    toast?.success("Share link turned off");
  }, "Couldn't turn the link off");

  return <Modal open={open} onClose={onClose} title="Share links for this game" size="md"
    description="Anyone with a live link can open this game's analysis and map replay without an account. Opponents are never named."
    footer={<Button variant="secondary" size="sm" onClick={onClose}>Done</Button>}>
    <div className="space-y-4">
      {list.error ? <RequestError title="Couldn't load your share links" error={list.error} onRetry={() => void list.mutate()} />
        : !list.data ? <p role="status" className="text-caption text-text-muted">Loading share links…</p>
        : <>
          {live.length ? <ul className="space-y-3" aria-label="Live link">
            {live.map((share) => <li key={share.token} className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-3">
              <p className="break-all font-mono text-caption text-text">{shareLinkUrl(share.token, window.location.origin)}</p>
              <p className="text-caption text-text-muted">Created {fmtDate(share.createdAt)} · {viewsLabel(share.viewCount)}</p>
              <div className="flex flex-wrap gap-2">
                <Button ref={copyButton} size="sm" variant="secondary" iconLeft={<Copy className="h-4 w-4" aria-hidden />}
                  onClick={() => void copier.copy(shareLinkUrl(share.token, window.location.origin))}>Copy link</Button>
                <Button size="sm" variant="danger" loading={pending === share.token} disabled={pending !== null}
                  onClick={() => void revoke(share)}>Turn off link</Button>
              </div>
            </li>)}
          </ul> : <div className="space-y-2">
            <p className="text-caption text-text-muted">This game has no live share link.</p>
            <Button ref={copyButton} size="sm" iconLeft={<Link2 className="h-4 w-4" aria-hidden />} loading={pending === "create"}
              disabled={pending !== null} onClick={() => void create()}>Create and copy a link</Button>
          </div>}
          {retired.length ? <div className="space-y-1">
            <h3 className="flex items-center gap-1.5 text-caption font-semibold text-text"><LinkIcon className="h-4 w-4" aria-hidden /> Turned off</h3>
            <ul className="space-y-1 text-caption text-text-muted">
              {retired.map((share) => <li key={share.token}>Created {fmtDate(share.createdAt)}, turned off {fmtDate(share.revokedAt)} · {viewsLabel(share.viewCount)}</li>)}
            </ul>
          </div> : null}
          <p className="text-caption text-text-muted">{list.data.activeCount} of {list.data.limit} live links used across your games.</p>
        </>}
    </div>
    <CopyRecoveryDialog text={copier.fallbackText} inputRef={copier.inputRef} triggerRef={copyButton} scopeKey={scope}
      onDismiss={copier.clear} title="Copy share link manually" label="Share link" />
  </Modal>;
}

function viewsLabel(count: number): string {
  return count === 1 ? "1 view" : `${count} views`;
}
