"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Eye,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { SkeletonBar } from "@/components/ui/Skeleton";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import { checkinsText } from "@/lib/buildIntent";
import {
  matchupLabel,
  raceIconName,
  raceTint,
  type Race,
  type VsRace,
} from "@/lib/race";
import type { DecoratedBuild } from "./types";
import { useBuildPublicationActions } from "./BuildPublicationActions";

export interface BuildCardProps {
  build: DecoratedBuild;
  onOpen: (slug: string) => void;
  onEdit: (slug: string) => void;
  onDelete: (slug: string) => void;
  onPublish: (slug: string) => void;
  onReclassify?: (slug: string) => void;
  onDuplicate?: (slug: string) => void;
  onChanged?: () => void | Promise<unknown>;
  reclassifying?: boolean;
  reclassifyDisabled?: boolean;
}

/**
 * BuildCard — race-tinted card representing one custom build in the
 * library grid. Clicking the body opens the dossier modal in place;
 * the kebab menu surfaces edit / publish / delete. The whole card has
 * a left rail in the build's race tint.
 */
export function BuildCard({
  build,
  onOpen,
  onEdit,
  onDelete,
  onPublish,
  onReclassify,
  onDuplicate,
  onChanged,
  reclassifying = false,
  reclassifyDisabled = false,
}: BuildCardProps) {
  const tint = raceTint(build.race);
  const matchup = matchupLabel(build.race, (build.vsRace as VsRace) ?? "Any");
  const stats = build.stats;
  const fromOpponent = build.perspective === "opponent";

  return (
    <Card
      variant="interactive"
      padded={false}
      className={[
        "group relative h-full overflow-hidden",
        "focus-within:border-border-strong",
      ].join(" ")}
    >
      <span
        aria-hidden
        className={["absolute left-0 top-0 h-full w-1", tint.rail].join(" ")}
      />
      <button
        type="button"
        onClick={() => onOpen(build.slug)}
        aria-label={`Open ${build.name || "build"} dossier`}
        className={[
          "absolute inset-0 z-0",
          "focus-visible:outline-none focus-visible:bg-bg-elevated",
        ].join(" ")}
      />
      <div className="relative pointer-events-none p-5 pl-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant="neutral"
                size="sm"
                className={[tint.bg, tint.border, tint.text].join(" ")}
                iconLeft={
                  <Icon
                    name={raceIconName(build.race)}
                    kind="race"
                    size={14}
                    decorative
                  />
                }
              >
                {matchup}
              </Badge>
              {fromOpponent ? (
                <Badge
                  variant="cyan"
                  size="sm"
                  iconLeft={<Eye className="h-3 w-3" aria-hidden />}
                >
                  From opponent
                </Badge>
              ) : null}
              {build.isPublic ? (
                <Badge variant="accent" size="sm">
                  Published
                </Badge>
              ) : null}
              {reclassifying ? (
                <Badge
                  variant="neutral"
                  size="sm"
                  iconLeft={
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  }
                >
                  Re-matching…
                </Badge>
              ) : null}
            </div>
            <h3 className="break-words text-h4 font-semibold leading-tight text-text">
              {build.name || "Untitled build"}
            </h3>
            {build.description ? (
              <p className="line-clamp-2 text-caption text-text-muted">
                {build.description}
              </p>
            ) : null}
          </div>
          <div className="pointer-events-auto">
            <BuildKebab
              slug={build.slug}
              name={build.name || "Untitled build"}
              isPublic={!!build.isPublic}
              onEdit={onEdit}
              onDelete={onDelete}
              onPublish={onPublish}
              onReclassify={onReclassify}
              onDuplicate={onDuplicate}
              onChanged={onChanged}
              reclassifying={reclassifying}
              reclassifyDisabled={reclassifyDisabled}
            />
          </div>
        </div>
        <BuildStatsRow build={build} stats={stats} />
      </div>
    </Card>
  );
}

function BuildStatsRow({
  build,
  stats,
}: {
  build: DecoratedBuild;
  stats: DecoratedBuild["stats"];
}) {
  const total = stats?.total ?? 0;
  const statsState = build.statsState ?? "ready";
  const statsPending = statsState === "loading";
  const statsUnavailable = statsState === "unavailable";
  const checkins = total > 0 ? checkinsText(stats?.checkins) : null;
  const played = stats?.lastPlayed;
  const latest = played || build.updatedAt;
  const lowSample = total > 0 && total < 5;
  return (
    <dl className="mt-4 flex flex-wrap items-end justify-between gap-3 text-caption">
      <div className="flex items-baseline gap-3">
        <div>
          <dt className="text-micro uppercase tracking-wider text-text-dim">
            Win rate
          </dt>
          <dd
            className="text-body font-semibold tabular-nums"
            style={{
              color: total && !lowSample
                ? wrColor(stats?.winRate ?? 0, total)
                : "rgb(var(--text-dim))",
            }}
          >
            {statsPending ? <span role="status" className="inline-flex h-5 items-center"><span className="sr-only">Loading stats</span><SkeletonBar className="h-5 w-12" /></span> : total > 0 ? pct1(stats?.winRate ?? 0) : "—"}
          </dd>
          {lowSample && !statsPending && !statsUnavailable ? <dd><Badge variant="warning" size="sm" title="Fewer than 5 games: this win rate can swing a lot">Low sample</Badge></dd> : null}
        </div>
        <div>
          <dt className="text-micro uppercase tracking-wider text-text-dim">
            Record
          </dt>
          <dd className="text-body tabular-nums text-text">
            {statsPending ? (
              <span className="inline-flex h-5 items-center" aria-hidden>
                <SkeletonBar className="h-5 w-16" />
              </span>
            ) : statsUnavailable ? (
              <span className="text-warning">Temporarily unavailable</span>
            ) : total > 0 ? (
              <>
                <span className="text-success">{stats?.wins ?? 0}W</span>
                <span className="px-0.5 text-text-dim">·</span>
                <span className="text-danger">{stats?.losses ?? 0}L</span>
              </>
            ) : (
              <span className="text-text-dim">No classified replays</span>
            )}
          </dd>
          {checkins && !statsPending && !statsUnavailable ? (
            <dd
              className="text-micro text-text-dim"
              title="Games you checked in to this build that the replay classified as something else"
            >
              {checkins}
            </dd>
          ) : null}
        </div>
      </div>
      <div className="text-right">
        {latest ? (
          <div title={new Date(latest).toLocaleString()} className="mt-1 text-micro text-text-dim">
            {played ? "Played" : "Edited"} {fmtAgo(latest)}
          </div>
        ) : null}
      </div>
    </dl>
  );
}

interface BuildKebabProps {
  slug: string;
  name: string;
  isPublic: boolean;
  onEdit: (slug: string) => void;
  onDelete: (slug: string) => void;
  onPublish: (slug: string) => void;
  onReclassify?: (slug: string) => void;
  onDuplicate?: (slug: string) => void;
  onChanged?: () => void | Promise<unknown>;
  compact?: boolean;
  reclassifying?: boolean;
  reclassifyDisabled?: boolean;
}

type MenuPlacement = "top" | "bottom";

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: MenuPlacement;
}

const MENU_WIDTH_PX = 208;
const MENU_ITEM_HEIGHT_PX = 44;
const MENU_CHROME_HEIGHT_PX = 10;
const MENU_GAP_PX = 8;
const MENU_VIEWPORT_GUTTER_PX = 12;

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

function visibleViewport() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

export function BuildKebab({
  slug,
  name,
  isPublic,
  onEdit,
  onDelete,
  onPublish,
  onReclassify,
  onDuplicate,
  onChanged,
  compact = false,
  reclassifying = false,
  reclassifyDisabled = false,
}: BuildKebabProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const menuId = useId();
  const menuItemCount = (compact ? 0 : 4 + (onReclassify ? 1 : 0)) + (onDuplicate ? 1 : 0) + (isPublic ? 3 : 0);
  const actions = useBuildPublicationActions({ slug, name, enabled: open && isPublic, onChanged });
  const listingState = actions.publication.error ? "Unavailable" : actions.publication.data?.published === false ? "Not published" : "Loading…";

  function stop<E extends SyntheticEvent>(e: E) {
    e.preventDefault();
    e.stopPropagation();
  }

  const closeMenu = useCallback((restoreTriggerFocus = false) => {
    const focusAtClose = document.activeElement;
    setOpen(false);
    setMenuPosition(null);
    if (restoreTriggerFocus) {
      window.requestAnimationFrame(() => {
        // A menu action can open a dialog before this frame. Preserve its
        // chosen focus instead of pulling the keyboard back to the menu.
        if (triggerRef.current?.isConnected && (document.activeElement === document.body || document.activeElement === focusAtClose)) triggerRef.current.focus();
      });
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const anchor = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewport = visibleViewport();
    const anchorHasGeometry = anchor.width > 0 || anchor.height > 0;
    if (
      anchorHasGeometry
      && (anchor.bottom <= viewport.top
        || anchor.top >= viewport.bottom
        || anchor.right <= viewport.left
        || anchor.left >= viewport.right)
    ) {
      closeMenu(false);
      return;
    }
    const viewportContentWidth = Math.max(
      0,
      viewport.width - MENU_VIEWPORT_GUTTER_PX * 2,
    );
    const viewportContentHeight = Math.max(
      0,
      viewport.height - MENU_VIEWPORT_GUTTER_PX * 2,
    );
    const width = Math.min(MENU_WIDTH_PX, viewportContentWidth);
    const naturalHeight = Math.max(
      menu.scrollHeight,
      menuRect.height,
      menuItemCount * MENU_ITEM_HEIGHT_PX + MENU_CHROME_HEIGHT_PX,
    );
    const roomBelow = Math.max(
      0,
      viewport.bottom
        - MENU_VIEWPORT_GUTTER_PX
        - anchor.bottom
        - MENU_GAP_PX,
    );
    const roomAbove = Math.max(
      0,
      anchor.top
        - viewport.top
        - MENU_VIEWPORT_GUTTER_PX
        - MENU_GAP_PX,
    );
    const placement: MenuPlacement =
      naturalHeight > roomBelow && roomAbove > roomBelow ? "top" : "bottom";
    const availableOnSide = placement === "top" ? roomAbove : roomBelow;
    const maxHeight = Math.min(
      naturalHeight,
      availableOnSide > 0 ? availableOnSide : viewportContentHeight,
    );
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const left = clamp(
      anchor.right - width,
      viewport.left + MENU_VIEWPORT_GUTTER_PX,
      viewport.right - MENU_VIEWPORT_GUTTER_PX - width,
    );
    const preferredTop =
      placement === "top"
        ? anchor.top - MENU_GAP_PX - renderedHeight
        : anchor.bottom + MENU_GAP_PX;
    const top = clamp(
      preferredTop,
      viewport.top + MENU_VIEWPORT_GUTTER_PX,
      viewport.bottom - MENU_VIEWPORT_GUTTER_PX - renderedHeight,
    );

    setMenuPosition((current) => {
      const next = { left, top, width, maxHeight, placement };
      return current
        && current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.maxHeight === next.maxHeight
        && current.placement === next.placement
        ? current
        : next;
    });
  }, [closeMenu, menuItemCount]);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;

    let frame = 0;
    const schedulePositionUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateMenuPosition);
    };
    const viewport = window.visualViewport;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePositionUpdate);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);
    if (menuRef.current) resizeObserver?.observe(menuRef.current);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    viewport?.addEventListener("resize", schedulePositionUpdate);
    viewport?.addEventListener("scroll", schedulePositionUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      viewport?.removeEventListener("resize", schedulePositionUpdate);
      viewport?.removeEventListener("scroll", schedulePositionUpdate);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;

    const focusFrame = window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      const item = initialFocusRef.current === "last"
        ? items?.[items.length - 1]
        : items?.[0];
      item?.focus();
    });
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [closeMenu, open]);

  function moveMenuFocus(event: ReactKeyboardEvent<HTMLUListElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "Home") {
      items[0]?.focus();
    } else if (event.key === "End") {
      items[items.length - 1]?.focus();
    } else if (event.key === "ArrowUp") {
      items[(currentIndex <= 0 ? items.length : currentIndex) - 1]?.focus();
    } else {
      items[(currentIndex + 1) % items.length]?.focus();
    }
  }

  const menuStyle: CSSProperties = menuPosition
    ? {
        left: menuPosition.left,
        top: menuPosition.top,
        width: menuPosition.width,
        maxHeight: menuPosition.maxHeight,
        visibility: "visible",
        transformOrigin:
          menuPosition.placement === "top" ? "bottom right" : "top right",
        paddingBottom: "max(0.25rem, env(safe-area-inset-bottom, 0px))",
      }
    : {
        left: -10_000,
        top: -10_000,
        width: MENU_WIDTH_PX,
        visibility: "hidden",
      };

  return (<>
    <div
      className="relative"
      onClick={(e: MouseEvent<HTMLDivElement>) => stop(e)}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={compact ? `More actions for ${name}` : `Build options for ${name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          stop(e);
          if (open) {
            closeMenu(false);
          } else {
            initialFocusRef.current = "first";
            setMenuPosition(null);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) {
            initialFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
            setMenuPosition(null);
            setOpen(true);
          }
        }}
        className={[
          "inline-flex h-11 w-11 items-center justify-center rounded-md",
          "text-text-muted hover:bg-bg-elevated hover:text-text",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        <MoreVertical className="h-5 w-5" aria-hidden />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
          <>
            <div
              aria-hidden
              data-testid="build-menu-scrim"
              onPointerDown={(event) => {
                event.preventDefault();
                closeMenu(true);
              }}
              className="fixed inset-0 z-[60] cursor-default bg-transparent"
            />
            <ul
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={`Build actions for ${name}`}
              aria-orientation="vertical"
              data-placement={menuPosition?.placement}
              onKeyDown={moveMenuFocus}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  next instanceof Node
                  && (menuRef.current?.contains(next)
                    || next === triggerRef.current)
                ) return;
                closeMenu(false);
              }}
              style={menuStyle}
              className={[
                "fixed z-[70] overflow-x-hidden overflow-y-auto overscroll-contain rounded-md",
                "border border-border bg-bg-surface py-1 shadow-[var(--shadow-card)]",
                "motion-safe:animate-[fadeIn_120ms_ease-out]",
              ].join(" ")}
            >
              {!compact ? <KebabItem icon={<ExternalLink className="h-4 w-4" aria-hidden />} label="Open full page" href={`/builds/${encodeURIComponent(slug)}`} onClick={() => closeMenu(false)} /> : null}
              {!compact ?
              <KebabItem
                icon={<Pencil className="h-4 w-4" aria-hidden />}
                label="Edit"
                onClick={() => {
                  closeMenu(false);
                  onEdit(slug);
                }}
              /> : null}
              {onDuplicate ? <KebabItem icon={<Copy className="h-4 w-4" aria-hidden />} label="Duplicate" onClick={() => { closeMenu(false); onDuplicate(slug); }} /> : null}
              {!compact && onReclassify ? (
                <KebabItem
                  icon={
                    reclassifying ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="h-4 w-4" aria-hidden />
                    )
                  }
                  label={reclassifying ? "Re-matching…" : "Re-match replays"}
                  disabled={reclassifying || reclassifyDisabled}
                  onClick={() => {
                    closeMenu(true);
                    onReclassify(slug);
                  }}
                />
              ) : null}
              {!compact ? <><li role="separator" className="my-1 border-t border-border" /><KebabItem
                icon={<Send className="h-4 w-4" aria-hidden />}
                label={isPublic ? "Update listing" : "Publish…"}
                onClick={() => {
                  closeMenu(false);
                  onPublish(slug);
                }}
              /></> : null}
              {isPublic ? <>
                <KebabItem icon={<ExternalLink className="h-4 w-4" aria-hidden />} label={actions.publicSlug ? "View on Community" : `View on Community · ${listingState}`} href={actions.publicSlug ? `/community/builds/${encodeURIComponent(actions.publicSlug)}` : undefined} disabled={!actions.publicSlug} onClick={() => closeMenu(false)} />
                <KebabItem icon={<Link2 className="h-4 w-4" aria-hidden />} label={actions.publicSlug ? "Copy public link" : `Copy public link · ${listingState}`} disabled={!actions.publicSlug} onClick={() => { void actions.copy(); closeMenu(true); }} />
                <KebabItem icon={<Send className="h-4 w-4" aria-hidden />} label="Unpublish" disabled={!actions.publicSlug} onClick={() => { actions.requestUnpublish(); closeMenu(false); }} />
                {actions.publication.error ? <KebabItem icon={<RefreshCw className="h-4 w-4" aria-hidden />} label="Couldn't load listing · Try again" onClick={() => { void actions.publication.mutate(); }} /> : null}
              </> : null}
              {!compact ? <><li role="separator" className="my-1 border-t border-border" /><KebabItem
                icon={<Trash2 className="h-4 w-4 text-danger" aria-hidden />}
                label="Delete"
                tone="danger"
                onClick={() => {
                  closeMenu(false);
                  onDelete(slug);
                }}
              /></> : null}
            </ul>
          </>,
          document.body,
        )
        : null}
    </div>
    {actions.dialogs}
    </>
  );
}

function KebabItem({
  icon,
  label,
  onClick,
  tone,
  disabled,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: "danger";
  disabled?: boolean;
  href?: string;
}) {
  const className = ["flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left text-caption focus-visible:outline-none focus-visible:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-60", tone === "danger" ? "text-danger hover:bg-danger/10" : "text-text hover:bg-bg-elevated"].join(" ");
  if (href && !disabled) return <li role="none"><Link role="menuitem" tabIndex={-1} href={href} onClick={onClick} className={className}>{icon}{label}</Link></li>;
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={onClick}
        disabled={disabled}
        className={[
          "flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left text-caption",
          "focus-visible:outline-none focus-visible:bg-bg-elevated",
          "disabled:cursor-not-allowed disabled:opacity-60",
          tone === "danger"
            ? "text-danger hover:bg-danger/10"
            : "text-text hover:bg-bg-elevated",
        ].join(" ")}
      >
        {icon}
        {label}
      </button>
    </li>
  );
}
