"use client";

/**
 * DockChat — the Stream Dock's live merged feed with moderation
 * affordances. Same message stream the OBS source shows, rendered
 * dense: platform status dots up top, newest at the bottom with
 * auto-stick (scrolling up pauses the stick until you return).
 *
 * Per-message actions (hover on desktop, tap to reveal in the OBS
 * dock / on touch):
 *   - Highlight — pins the message on stream (studio state).
 *   - Block — adds the author to the studio blocklist. Two-tap: the
 *     first tap arms ("Confirm?"), the second within the window
 *     commits — mis-taps in a 300px dock are cheap, unblocking isn't.
 */

import { useEffect, useRef, useState } from "react";
import { fallbackColor } from "@/lib/multichat/feed";
import { PLATFORM_META } from "@/components/overlay/widgets/MultiChatMessageList";
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
  statuses,
  blockedUsers,
  busy,
  onHighlight,
  onBlock,
}: {
  loaded: boolean;
  platforms: MultichatConfig | null;
  messages: ReadonlyArray<ChatMessage>;
  statuses: Partial<
    Record<ChatPlatform, { state: PlatformState; detail?: string }>
  >;
  blockedUsers: ReadonlyArray<string>;
  busy: boolean;
  onHighlight: (message: ChatMessage) => void;
  onBlock: (user: string) => void;
}) {
  const enabled = configuredPlatforms(platforms);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  // Tap-to-reveal actions (touch has no hover); keyed (platform:id).
  const [selected, setSelected] = useState<string | null>(null);
  // Armed Block target — one at a time, self-disarms.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
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

  const blocked = new Set(blockedUsers.map((u) => u.toLowerCase()));

  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-bg-surface">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
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
          return (
            <span
              key={p}
              className="inline-flex items-center gap-1.5 text-micro text-text-muted"
              title={statuses[p]?.detail || st}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: STATE_DOT[st] }}
              />
              {PLATFORM_META[p].label}
            </span>
          );
        })}
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="dock-chat-list"
        className="h-[50vh] min-h-48 overflow-y-auto px-2 py-1.5 lg:h-[calc(100vh-6rem)]"
      >
        {messages.length === 0 ? (
          <div className="px-1 py-2 text-caption text-text-dim">
            {enabled.length > 0
              ? "Connected — waiting for chat…"
              : "Chat appears here once a platform is configured."}
          </div>
        ) : (
          messages.map((m) => {
            const key = `${m.platform}:${m.id}`;
            const meta = PLATFORM_META[m.platform];
            const isBlocked = blocked.has(m.user.trim().toLowerCase());
            const showActions = selected === key;
            return (
              <div
                key={key}
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
