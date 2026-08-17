"use client";

/**
 * DockChat — the Stream Dock's live merged feed with moderation
 * affordances. Same message stream the OBS source shows, rendered
 * dense: platform status dots up top, newest at the bottom with
 * auto-stick (scrolling up pauses the stick until you return).
 *
 * The header doubles as the audience readout: each platform's live
 * viewer count sits next to its status dot, and the combined total
 * anchors the right edge. A count we can't read truthfully is simply
 * absent — never a zero (see lib/multichat/useViewerCounts).
 *
 * Normalized follows/subs/gifts/raids are interleaved as read-only event
 * cards, so notification rows can never be mistaken for moderation targets.
 *
 * Per-message actions (hover on desktop, tap to reveal in the OBS
 * dock / on touch):
 *   - Highlight — pins the message on stream (studio state).
 *   - Block — adds the author to the studio blocklist. Two-tap: the
 *     first tap arms ("Confirm?"), the second within the window
 *     commits — mis-taps in a 300px dock are cheap, unblocking isn't.
 */

import { useEffect, useRef, useState } from "react";
import { fallbackColor, mergeDisplayFeed } from "@/lib/multichat/feed";
import {
  excludeBlockedUsers,
  isBlockedUser,
  normalizedBlockedUserSet,
} from "@/lib/multichat/appearance";
import {
  chatEventIdentity,
  EVENT_KIND_LABEL,
  type ChatEvent,
} from "@/lib/multichat/events";
import { PLATFORM_META } from "@/components/overlay/widgets/MultiChatMessageList";
import {
  EMPTY_VIEWER_COUNTS,
  formatViewers,
  type ViewerCounts,
} from "@/lib/multichat/useViewerCounts";
import type {
  ChatMessage,
  ChatPlatform,
  MultichatConfig,
  PlatformState,
} from "@/lib/multichat/types";

const STATE_DOT: Record<PlatformState, string> = {
  off: "#6b7280",
  connecting: "#f5b942",
  connected: "#3ec07a",
  offline: "#6b7280",
  ended: "#6b7280",
  error: "#ff6b6b",
};

/** How long an armed Block stays armed before it disarms itself. */
const BLOCK_ARM_MS = 3000;

/** Bottom-distance under which the list counts as "stuck" to the end. */
const STICK_SLACK_PX = 48;

function configuredPlatforms(config: MultichatConfig | null): ChatPlatform[] {
  if (!config) return [];
  const out: ChatPlatform[] = [];
  if (config.twitch?.enabled && config.twitch.channel) out.push("twitch");
  if (config.kick?.enabled && config.kick.chatroomId) out.push("kick");
  if (config.youtube?.enabled && config.youtube.channel) out.push("youtube");
  if (config.tiktok?.enabled && config.tiktok.username) out.push("tiktok");
  return out;
}

function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function DockChat({
  loaded,
  platforms,
  messages,
  events = [],
  statuses,
  blockedUsers,
  busy,
  viewers = EMPTY_VIEWER_COUNTS,
  onHighlight,
  onBlock,
}: {
  loaded: boolean;
  platforms: MultichatConfig | null;
  messages: ReadonlyArray<ChatMessage>;
  /** Read-only platform events; blocked authors are filtered from the Dock. */
  events?: ReadonlyArray<ChatEvent>;
  statuses: Partial<
    Record<ChatPlatform, { state: PlatformState; detail?: string }>
  >;
  blockedUsers: ReadonlyArray<string>;
  busy: boolean;
  /** Live audience per platform + combined; blank until it loads. */
  viewers?: ViewerCounts;
  onHighlight: (message: ChatMessage) => void;
  onBlock: (user: string) => void;
}) {
  const enabled = configuredPlatforms(platforms);
  // Counts hang off the status row that's already there — no new
  // chrome, no second strip to eat the dock's vertical budget.
  const anyKnown = viewers.platforms.some((p) => p.viewers !== null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  // Tap-to-reveal actions (touch has no hover); keyed (platform:id).
  const [selected, setSelected] = useState<string | null>(null);
  // Armed Block target — one at a time, self-disarms.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocked = normalizedBlockedUserSet(blockedUsers);
  const visibleEvents = excludeBlockedUsers(events, blocked);
  const displayRows = mergeDisplayFeed(messages, visibleEvents);

  useEffect(() => {
    const el = listRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, events]);
  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stuckRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK_PX;
  };

  const tapBlock = (user: string) => {
    if (armed === user) {
      if (armTimer.current) clearTimeout(armTimer.current);
      setArmed(null);
      onBlock(user);
      return;
    }
    setArmed(user);
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => setArmed(null), BLOCK_ARM_MS);
  };

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-bg-surface">
      {/* Status + audience share one wrapping row: tighter gaps keep
          all four platforms plus the total inside two lines even at
          OBS-dock width, and a wrapped line costs a hair of height
          rather than a full row. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-3 py-2">
        <span className="text-micro font-bold uppercase tracking-widest text-accent-cyan">
          Live chat
        </span>
        {enabled.length === 0 && loaded ? (
          <span className="text-micro text-text-dim">
            no platforms configured — set them up in Settings
          </span>
        ) : null}
        {enabled.map((p) => {
          const st = statuses[p]?.state ?? "connecting";
          const platformViewers = viewers.platforms.find(
            (entry) => entry.platform === p,
          );
          const count = platformViewers?.viewers ?? null;
          return (
            <span
              key={p}
              className="inline-flex items-center gap-1 whitespace-nowrap text-micro text-text-muted"
              title={statuses[p]?.detail || st}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: STATE_DOT[st] }}
              />
              {PLATFORM_META[p].label}
              {/* Unknown counts render nothing at all — a placeholder
                  dash in every row is the clutter this avoids. */}
              {count !== null ? (
                <span
                  data-testid={`dock-viewers-${p}`}
                  className="tabular-nums text-text"
                  title={
                    `${count.toLocaleString("en-US")} currently watching on ${PLATFORM_META[p].label}` +
                    (platformViewers?.raidAdjusted
                      ? " — includes a recent raid while the platform count refreshes"
                      : "")
                  }
                >
                  {formatViewers(count)}
                </span>
              ) : null}
            </span>
          );
        })}
        {anyKnown ? (
          <span
            data-testid="dock-viewers-total"
            className="ml-auto inline-flex items-baseline gap-1 whitespace-nowrap"
            title={
              viewers.settlingRaid
                ? `${viewers.total.toLocaleString("en-US")} estimated across platforms while a recent raid settles into the official count`
                : viewers.partial
                ? `${viewers.total.toLocaleString("en-US")} currently watching across the platforms we could reach — at least one didn't report`
                : `${viewers.total.toLocaleString("en-US")} currently watching across all platforms`
            }
          >
            <span className="tabular-nums text-caption font-semibold text-text">
              {formatViewers(viewers.total)}
            </span>
            <span className="text-micro text-text-dim">
              {viewers.partial ? "watching now+" : "watching now"}
            </span>
          </span>
        ) : null}
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="dock-chat-list"
        className="h-[50vh] min-h-48 overflow-y-auto px-2 py-1.5 lg:h-[calc(100vh-6rem)]"
      >
        {displayRows.length === 0 ? (
          <div className="px-1 py-2 text-caption text-text-dim">
            {enabled.length > 0
              ? "Connected — waiting for chat…"
              : "Chat appears here once a platform is configured."}
          </div>
        ) : (
          displayRows.map((row) => {
            if (row.rowType === "event") {
              const event = row.item;
              const meta = PLATFORM_META[event.platform];
              return (
                <div
                  key={`event:${chatEventIdentity(event)}`}
                  data-testid="dock-event-row"
                  aria-label={[
                    `${meta.label} ${EVENT_KIND_LABEL[event.kind]}`,
                    event.user,
                    event.detail,
                    event.amount,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  className="my-1 rounded-md border border-accent-cyan/30 border-l-4 bg-accent-cyan/10 px-2 py-1.5 text-caption leading-snug"
                  style={{ borderLeftColor: meta.color }}
                >
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="tabular-nums text-micro text-text-dim">
                      {timeLabel(event.atMs)}
                    </span>
                    <span
                      className="inline-flex h-4 shrink-0 items-center justify-center rounded px-1.5 align-middle text-micro font-extrabold leading-none tracking-wide"
                      style={{ background: meta.color, color: meta.fg }}
                      title={`${meta.label} event`}
                      aria-label={`${meta.label} event`}
                    >
                      {meta.short}
                    </span>
                    <span
                      className="text-micro font-extrabold uppercase tracking-wider"
                      style={{ color: meta.color }}
                    >
                      {EVENT_KIND_LABEL[event.kind]}
                    </span>
                    {event.amount ? (
                      <span className="ml-auto font-bold tabular-nums text-[#f2c66d]">
                        {event.amount}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 min-w-0 break-words text-text">
                    <span
                      className="font-semibold"
                      style={{ color: fallbackColor(event.user) }}
                    >
                      {event.user}
                    </span>
                    {event.detail ? (
                      <span className="text-text-muted">
                        {" "}
                        {event.detail}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            }

            const m = row.item;
            const key = `${m.platform}:${m.id}`;
            const meta = PLATFORM_META[m.platform];
            const isBlocked = isBlockedUser(m.user, blocked);
            const showActions = selected === key;
            return (
              <div
                key={`message:${key}`}
                className={`group rounded-md px-1 py-0.5 text-caption leading-snug hover:bg-bg-elevated ${isBlocked ? "opacity-40" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => setSelected(showActions ? null : key)}
                  className="block w-full min-w-0 break-words text-left"
                >
                  <span className="mr-1.5 tabular-nums text-micro text-text-dim">
                    {timeLabel(m.atMs)}
                  </span>
                  <span
                    className="mr-1.5 inline-flex h-4 shrink-0 items-center justify-center rounded px-1.5 align-middle text-micro font-extrabold leading-none tracking-wide"
                    style={{ background: meta.color, color: meta.fg }}
                    title={`${meta.label} chat`}
                    aria-label={`${meta.label} chat`}
                  >
                    {meta.short}
                  </span>
                  <span
                    className="font-semibold"
                    style={{ color: m.color || fallbackColor(m.user) }}
                  >
                    {m.user}
                  </span>
                  {isBlocked ? (
                    <span className="ml-1 text-micro text-text-dim">
                      (blocked)
                    </span>
                  ) : null}
                  <span className="text-text-dim">: </span>
                  <span className="text-text">{m.text}</span>
                </button>
                <div
                  className={`${showActions ? "flex" : "hidden group-hover:flex"} mt-0.5 gap-1.5 pl-5`}
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onHighlight(m)}
                    className="rounded border border-accent-cyan/50 px-1.5 py-0.5 text-micro text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50"
                  >
                    Highlight
                  </button>
                  {!isBlocked ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => tapBlock(m.user)}
                      className={`rounded border px-1.5 py-0.5 text-micro disabled:opacity-50 ${
                        armed === m.user
                          ? "border-danger bg-danger/15 font-semibold text-danger"
                          : "border-danger/50 text-danger hover:bg-danger/10"
                      }`}
                    >
                      {armed === m.user ? "Confirm?" : "Block"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
