"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { CircleHelp, Image as ImageIcon, Link2, ListChecks } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { useCopy } from "@/lib/useCopy";
import { trackCardShared } from "@/lib/analytics/shareEvents";
import { activeShare, gameSharesPath, shareLinkUrl, type GameShare, type GameShareList } from "@/lib/gameShares";
import { ShareMenu, type ShareMenuHandle, type ShareMenuItem } from "./ShareMenu";
import type { GameSummary } from "./types";

const ShareLinksDialog = dynamic(() => import("./ShareLinksDialog").then((value) => value.ShareLinksDialog));

/**
 * The game's Share menu (game page header and Replay Library rows).
 *
 * - **Copy share link**: the game's revocable public link, created on first
 *   use. Anyone with it can open the redacted analysis and map replay at
 *   /g/<token> without an account.
 * - **Save battle card image**: the 1200×630 battle card through the shared
 *   delivery pipeline (Web Share → clipboard → download).
 * - **Manage share links**: views, copy and turn off.
 *
 * The rows are a ``ShareMenuItem[]`` so later rows only append. Copying uses
 * ``useCopy`` with the manual-copy dialog as the clipboard fallback.
 * Safe without a ToastProvider (the toasts no-op).
 */
export function ShareGameButton({
  game,
  className,
  compact = false,
  label,
}: {
  game: GameSummary;
  className?: string;
  /** Icon-only trigger for dense rows. */
  compact?: boolean;
  /** Accessible name of the trigger, e.g. naming the row's game. */
  label?: string;
}) {
  const toast = useToastOptional()?.toast;
  const { getToken } = useAuth();
  const menu = useRef<ShareMenuHandle>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [opened, setOpened] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [managing, setManaging] = useState(false);
  // Read the game's links only once the menu has been opened.
  const sharesReq = useApi<GameShareList>(opened ? gameSharesPath(game.gameId) : null,
    { revalidateOnFocus: false, shouldRetryOnError: false });
  const [scope] = useState(() => ({ gameId: game.gameId }));
  const copier = useCopy({ scopeKey: scope, onCopied: () => toast?.success("Link copied") });

  const copyShareLink = async () => {
    triggerRef.current = menu.current?.trigger ?? null;
    const live = activeShare(sharesReq.data);
    if (live) { await copier.copy(shareLinkUrl(live.token, window.location.origin)); return; }
    setCreating(true);
    try {
      const out = await apiCall<{ share: GameShare }>(getToken, gameSharesPath(game.gameId), { method: "POST", body: "{}" });
      void sharesReq.mutate();
      await copier.copy(shareLinkUrl(out.share.token, window.location.origin));
    } catch (error) {
      toast?.error("Couldn't create a share link", { description: (error as ClientApiError)?.message || "Please try again." });
    } finally {
      setCreating(false);
    }
  };

  const saveImage = async () => {
    if (rendering) return;
    setRendering(true);
    try {
      const [{ battleCardFilename, battleCardShareText, renderBattleCardPng }, { deliverShareCard, shareOutcome }] =
        await Promise.all([import("@/lib/battleCard"), import("@/components/analyzer/arcade/ShareCard")]);
      const blob = await renderBattleCardPng(game);
      if (!blob) {
        toast?.error("Couldn't render the battle card");
        return;
      }
      const { shared, method } = await deliverShareCard({
        blob,
        title: "SC2 Battle Card",
        text: battleCardShareText(game),
        filename: battleCardFilename(game),
      });
      // Nothing delivered means the player dismissed the share sheet.
      if (!shared || !method) return;
      trackCardShared({ card: "battle_card", method });
      toast?.success(shareOutcome("Battle card", method));
    } catch {
      toast?.error("Share failed");
    } finally {
      setRendering(false);
    }
  };

  const live = activeShare(sharesReq.data);
  const items: ShareMenuItem[] = [
    {
      id: "share-link",
      label: "Copy share link",
      sublabel: live
        ? `Your live link, opened ${live.viewCount === 1 ? "once" : `${live.viewCount} times`}. No account needed to view.`
        : "Anyone with the link can open this game. No account needed.",
      icon: <Link2 className="h-4 w-4" />,
      busy: creating,
      keepOpen: true,
      onSelect: copyShareLink,
    },
    {
      id: "image",
      label: rendering ? "Preparing battle card…" : "Save battle card image",
      sublabel: "A picture of the result. Opponents stay unnamed.",
      icon: <ImageIcon className="h-4 w-4" />,
      busy: rendering,
      onSelect: saveImage,
    },
    {
      id: "manage",
      label: "Manage share links…",
      sublabel: "See views, copy or turn a link off",
      icon: <ListChecks className="h-4 w-4" />,
      onSelect: () => setManaging(true),
    },
    {
      id: "help",
      label: "How sharing works",
      icon: <CircleHelp className="h-4 w-4" />,
      href: "/help/game-page-sharing",
    },
  ];

  return <>
    <ShareMenu ref={menu} items={items} label="Share" ariaLabel={label ?? (compact ? "Share this game" : undefined)} compact={compact} className={className}
      onOpen={() => setOpened(true)} />
    <CopyRecoveryDialog text={copier.fallbackText} inputRef={copier.inputRef} triggerRef={triggerRef} scopeKey={scope}
      onDismiss={copier.clear} title="Copy share link manually" label="Share link" />
    {managing ? <ShareLinksDialog gameId={game.gameId} open={managing} onClose={() => setManaging(false)} /> : null}
  </>;
}
