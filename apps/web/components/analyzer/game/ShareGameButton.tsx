"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useAuth } from "@clerk/nextjs";
import { CircleHelp, Clock3, Globe, Image as ImageIcon, Link2, ListChecks, LockKeyhole } from "lucide-react";
import { useToastOptional } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { ReplaySharingDisclosure } from "@/components/analyzer/replays/ReplaySharingDisclosure";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { useCopy } from "@/lib/useCopy";
import { trackCardShared } from "@/lib/analytics/shareEvents";
import { activeShare, gameSharesPath, shareLinkUrl, type GameShare, type GameShareList } from "@/lib/gameShares";
import { formatGameClock } from "@/lib/macro";
import { gameAnalysisHref } from "@/lib/opponentNavigation";
import { gameReplayHref } from "@/lib/replayLink";
import { publicGameHref, useReplaySharing } from "@/lib/useReplaySharing";
import { ShareMenu, type ShareMenuHandle, type ShareMenuItem } from "./ShareMenu";
import type { GameSummary } from "./types";

const ShareLinksDialog = dynamic(() => import("./ShareLinksDialog").then((value) => value.ShareLinksDialog));
const COPIED = "Link copied";

/**
 * The game's Share menu (game page header and Replay Library rows). Rows,
 * in order:
 *
 * - **Copy link at m:ss** (game page, from the shared clock, hidden under
 *   1 s) and **Copy link to this game**: owner-only addresses.
 * - **Copy public link** when public replays are on, or **Turn on public
 *   replays…**, which asks with the Replays page's disclosure first. Hidden
 *   for resumed-from-replay games (never on the public page) and when the
 *   sharing status can't be read.
 * - **Save battle card image**: the battle card through the shared delivery
 *   pipeline (Web Share → clipboard → download).
 * - **Copy share link**: the game's revocable /g/<token> link, created on
 *   first use; anyone with it can open the redacted analysis, no account.
 * - **Manage share links…** and **How sharing works**.
 *
 * The rows are a ``ShareMenuItem[]`` so features append. Copying uses
 * ``useCopy`` with the manual-copy dialog as the fallback. Safe without a
 * ToastProvider (the toasts no-op).
 */
export function ShareGameButton({
  game,
  className,
  compact = false,
  label,
  currentTimeSec = null,
}: {
  game: GameSummary;
  className?: string;
  /** Icon-only trigger for dense rows. */
  compact?: boolean;
  /** Accessible name of the trigger, e.g. naming the row's game. */
  label?: string;
  /** The game page's shared replay clock; rows have none. */
  currentTimeSec?: number | null;
}) {
  const toast = useToastOptional()?.toast;
  const { getToken } = useAuth();
  const menu = useRef<ShareMenuHandle>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const copiedMessage = useRef(COPIED);
  const [opened, setOpened] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [managing, setManaging] = useState(false);
  const [confirmPublic, setConfirmPublic] = useState(false);
  // Read the game's links and the sharing status once the menu has opened.
  const sharesReq = useApi<GameShareList>(opened ? gameSharesPath(game.gameId) : null,
    { revalidateOnFocus: false, shouldRetryOnError: false });
  const replaySharing = useReplaySharing(opened);
  const [scope] = useState(() => ({ gameId: game.gameId }));
  const copier = useCopy({ scopeKey: scope, onCopied: () => {
    toast?.success(copiedMessage.current);
    copiedMessage.current = COPIED;
  } });
  const live = activeShare(sharesReq.data);

  const copy = (href: string, message = COPIED) => {
    triggerRef.current = menu.current?.trigger ?? null;
    copiedMessage.current = message;
    return copier.copy(new URL(href, window.location.origin).href);
  };

  const copyShareLink = async () => {
    if (live) { await copy(shareLinkUrl(live.token, window.location.origin)); return; }
    setCreating(true);
    try {
      const out = await apiCall<{ share: GameShare }>(getToken, gameSharesPath(game.gameId), { method: "POST", body: "{}" });
      void sharesReq.mutate();
      await copy(shareLinkUrl(out.share.token, window.location.origin));
    } catch (error) {
      toast?.error("Couldn't create a share link", { description: (error as ClientApiError)?.message || "Please try again." });
    } finally {
      setCreating(false);
    }
  };

  const turnOnPublicReplays = async () => {
    try {
      const next = await replaySharing.setEnabled(true);
      setConfirmPublic(false);
      if (next.handle) await copy(publicGameHref(next.handle, game.gameId, window.location.origin), "Public replay page is live. Link copied.");
    } catch (error) {
      setConfirmPublic(false);
      toast?.error("Couldn't turn on public replays", { description: (error as ClientApiError)?.message || "Please try again." });
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

  const moment = typeof currentTimeSec === "number" && Number.isFinite(currentTimeSec) && currentTimeSec >= 1
    ? Math.floor(currentTimeSec) : null;
  const items: ShareMenuItem[] = [
    ...(moment !== null ? [{
      id: "moment",
      label: `Copy link at ${formatGameClock(moment)}`,
      sublabel: "Opens the replay at this moment · only you can open it",
      icon: <Clock3 className="h-4 w-4" />,
      keepOpen: true,
      onSelect: () => copy(gameReplayHref(game.gameId, moment)),
    }] : []),
    {
      id: "game",
      label: "Copy link to this game",
      sublabel: "Only you can open it",
      icon: <LockKeyhole className="h-4 w-4" />,
      keepOpen: true,
      onSelect: () => copy(gameAnalysisHref(game.gameId)),
    },
    ...publicRows(),
    {
      id: "image",
      label: rendering ? "Preparing battle card…" : "Save battle card image",
      sublabel: "A picture of the result. Opponents stay unnamed.",
      icon: <ImageIcon className="h-4 w-4" />,
      busy: rendering,
      onSelect: saveImage,
    },
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

  function publicRows(): ShareMenuItem[] {
    // Resumed games never reach the public replay page; an unreadable
    // status (failed or signed out) hides the public rows silently.
    if (game.isResumedFromReplay === true || replaySharing.unavailable || !replaySharing.sharing) return [];
    const href = replaySharing.publicGameHref(game.gameId);
    if (href) {
      return [{
        id: "public",
        label: "Copy public link",
        sublabel: "Opens this game on your public replay page. Viewers sign in to see the analysis; your notes stay private.",
        icon: <Globe className="h-4 w-4" />,
        keepOpen: true,
        onSelect: () => copy(href),
      }];
    }
    return [{
      id: "public-on",
      label: "Turn on public replays…",
      sublabel: "Puts your whole replay archive on your public player page",
      icon: <Globe className="h-4 w-4" />,
      busy: replaySharing.saving,
      onSelect: () => setConfirmPublic(true),
    }];
  }

  return <>
    <ShareMenu ref={menu} items={items} label="Share" ariaLabel={label ?? (compact ? "Share this game" : undefined)} compact={compact} className={className}
      onOpen={() => setOpened(true)} />
    <CopyRecoveryDialog text={copier.fallbackText} inputRef={copier.inputRef} triggerRef={triggerRef} scopeKey={scope}
      onDismiss={copier.clear} title="Copy link manually" label="Link to copy" />
    <ConfirmDialog open={confirmPublic} onClose={() => { if (!replaySharing.saving) setConfirmPublic(false); }}
      onConfirm={() => void turnOnPublicReplays()} loading={replaySharing.saving}
      title="Turn on public replays?" confirmLabel="Turn on and copy link" focusCancel>
      <ReplaySharingDisclosure />
    </ConfirmDialog>
    {managing ? <ShareLinksDialog gameId={game.gameId} open={managing} onClose={() => setManaging(false)} /> : null}
  </>;
}
