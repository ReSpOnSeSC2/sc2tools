"use client";

import { useMemo, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Copy, ImageDown, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { Modal } from "@/components/ui/Modal";
import { useToastOptional } from "@/components/ui/Toast";
import { battleReportFacts } from "@/lib/battleReport/facts";
import { planBattleReport } from "@/lib/battleReport/plan";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { activeShare, gameSharesPath, shareApiPath, shareLinkUrl, type GameShare, type GameShareList } from "@/lib/gameShares";
import { sharedReportInput, type SharedGameAnalysis } from "@/lib/sharedGame";
import { useCopy } from "@/lib/useCopy";
import { usePublicApi } from "@/lib/usePublicApi";

/**
 * Compose a public battle report: the game's share link (created only when
 * asked), a preview built from exactly what the link serves (the redacted
 * share payload, so what you see is what viewers get), a link that opens at
 * the report, and the report image. Turning the link off removes the report
 * with it.
 */
export function ShareReportDialog({ gameId, open, onClose }: { gameId: string; open: boolean; onClose: () => void }) {
  const { getToken } = useAuth();
  const toast = useToastOptional()?.toast;
  const list = useApi<GameShareList>(open ? gameSharesPath(gameId) : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  const live = activeShare(list.data);
  const shared = usePublicApi<SharedGameAnalysis>(live ? shareApiPath(live.token) : null, { revalidateOnFocus: false, shouldRetryOnError: false });
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scope] = useState(() => ({ gameId }));
  const copier = useCopy({ scopeKey: scope, onCopied: () => toast?.success("Report link copied") });
  const copyButton = useRef<HTMLButtonElement>(null);
  const report = useMemo(() => live && shared.data
    ? planBattleReport(battleReportFacts(sharedReportInput(shared.data, `share-${live.token}`)), "battle")
    : null, [live, shared.data]);

  const create = async () => {
    setCreating(true);
    try {
      await apiCall<{ share: GameShare }>(getToken, gameSharesPath(gameId), { method: "POST", body: "{}" });
      await list.mutate();
    } catch (error) {
      toast?.error("Couldn't create a share link", { description: (error as ClientApiError)?.message || "Please try again." });
    } finally {
      setCreating(false);
    }
  };
  const saveImage = async () => {
    if (!report || !shared.data) return;
    setSaving(true);
    try {
      const image = await import("@/lib/battleReportImage");
      const blob = await image.renderBattleReportPng(report, {
        mine: shared.data.macroBreakdown?.stats_events, opponent: shared.data.macroBreakdown?.opp_stats_events, result: shared.data.game.result,
      });
      if (!blob) throw new Error("no canvas");
      image.downloadBlob(blob, image.battleReportImageFilename(report));
    } catch {
      toast?.error("Couldn't make the image");
    } finally {
      setSaving(false);
    }
  };

  const paragraph = report?.paragraphs[0]?.sentences.map((sentence) => sentence.text).join(" ");
  return <Modal open={open} onClose={onClose} title="Share this battle report" size="md"
    description="Anyone with the link can read the report and open the game's analysis and map replay, without an account. Players appear by race; no names or ratings are shown."
    footer={<Button variant="secondary" size="sm" onClick={onClose}>Done</Button>}>
    <div className="space-y-4">
      {list.error ? <p role="alert" className="text-caption text-danger">Couldn&apos;t load this game&apos;s share link. Close and try again.</p>
        : !list.data ? <p role="status" className="text-caption text-text-muted">Checking this game&apos;s share link…</p>
        : !live ? <div className="space-y-2">
          <p className="text-caption text-text-muted">Sharing the report uses this game&apos;s share link. You can turn it off later in Share → Manage share links.</p>
          <Button size="sm" loading={creating} iconLeft={<Link2 className="h-4 w-4" aria-hidden />} onClick={() => void create()}>Create share link</Button>
        </div>
        : <>
          {shared.error ? <p role="alert" className="text-caption text-danger">Couldn&apos;t load the shared report preview.</p>
            : !report ? <p role="status" className="text-caption text-text-muted">Preparing the preview…</p>
            : <article aria-label="Report preview" className="space-y-2 rounded-lg border border-border bg-bg-elevated/40 p-4">
              <p className="text-micro uppercase tracking-widest text-text-dim">What viewers see</p>
              <h3 className="break-words font-display text-h3 font-bold text-text">{report.headline}</h3>
              {paragraph ? <p className="break-words font-serif text-body text-text">{paragraph}</p> : null}
            </article>}
          <div className="flex flex-wrap gap-2">
            <Button ref={copyButton} size="sm" iconLeft={<Copy className="h-4 w-4" aria-hidden />}
              onClick={() => void copier.copy(shareLinkUrl(live.token, window.location.origin, "battle-report"))}>Copy report link</Button>
            <Button size="sm" variant="secondary" loading={saving} disabled={!report} iconLeft={<ImageDown className="h-4 w-4" aria-hidden />}
              onClick={() => void saveImage()}>Save as image</Button>
          </div>
        </>}
    </div>
    <CopyRecoveryDialog text={copier.fallbackText} inputRef={copier.inputRef} triggerRef={copyButton} scopeKey={scope}
      onDismiss={copier.clear} title="Copy report link manually" label="Report link" />
  </Modal>;
}
