"use client";

import { useAuth } from "@clerk/nextjs";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { API_BASE, apiCall, useApi, useOwnerRequestScope } from "@/lib/clientApi";
import { blockedUserSet, excludeBlockedUsers, sanitizeAppearance } from "@/lib/multichat/appearance";
import { CHAT_COMMAND_CATALOG, type ChatCommandPreferences, type CommandOptions } from "@/lib/multichat/chatCommandPreferences";
import { FEED_CAP } from "@/lib/multichat/feed";
import type { ChatMessage, MultichatConfig } from "@/lib/multichat/types";
import { useMultiChat } from "@/lib/multichat/useMultiChat";

const PLATFORMS = { twitch: "Twitch", kick: "Kick", youtube: "YouTube" } as const;
type Platform = keyof typeof PLATFORMS;
type Connection = {
  platform: Platform;
  configured?: boolean;
  connected?: boolean;
  chatAvailable?: boolean;
  chatConsent?: boolean;
  connectedAt?: string | null;
  platformUserName?: string;
};
type ReplyRow = { platform: Platform; source: string; id: string; user: string; text: string };
type ReplyResult = { status: string; message?: string };
type OwnerRepliesProps = { owner: string; token: string; commands: ChatCommandPreferences };
const COMMAND = /^!([a-z][a-z0-9_]{0,23})(?:\s+(.{1,80}))?$/iu;
const MESSAGE_UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const ROW_CAP = 8;
const REPLY_PATH = "/v1/me/chat-commands/reply";
const NO_RECEIPT = "Couldn’t confirm delivery. Check the source chat before sending again.";
const OUTCOMES: Record<string, string> = {
  sent: "Reply sent to the source chat.",
  already_answered: "A reply was already attempted for this message. Check the source chat.",
  cooldown: "This command or viewer is cooling down.",
  disabled: "This command is disabled for the source platform.",
  unknown: "No saved command matches this message.",
  private_command: "This command uses private game or player details. Choose a different command.",
  reply: "There is no reply available for this command.",
  unavailable: "The selected overlay token or chat settings changed. Reopen live replies and try again.",
  own_message: "Your own chat messages do not need a reply.",
  bot_enabled: "Your Twitch bot already answers commands in this channel.",
  unconfirmed: NO_RECEIPT,
};
const receiptKey = ({ platform, id }: ReplyRow) => `${platform}:${id}`;
const terminal = (status: string) => ["sent", "already_answered", "unconfirmed"].includes(status);

function canSend(row: Connection) {
  return row.configured === true && row.connected === true && row.chatAvailable === true && row.chatConsent === true;
}

function liveConfig(config: MultichatConfig | undefined, grants: Connection[]) {
  if (!config) return null;
  const ready = new Set(grants.filter(canSend).map(row => row.platform));
  const enabled = (platform: Platform) => ready.has(platform) && config[platform]?.enabled === true && config[platform]?.channel;
  return {
    ...(enabled("twitch") ? { twitch: config.twitch } : {}),
    ...(enabled("kick") && config.kick?.chatroomId ? { kick: config.kick } : {}),
    ...(enabled("youtube") ? { youtube: config.youtube } : {}),
  };
}

function sourceFor({ id, replySource }: ChatMessage, platform: Platform) {
  if (platform === "youtube") return /^([\w-]{11}):./u.exec(id)?.[1];
  return MESSAGE_UUID.test(id) ? replySource : undefined;
}

function liveCommandNames(commands: ChatCommandPreferences) {
  const names = new Map<string, CommandOptions>();
  for (const row of commands.builtins) {
    const builtin = CHAT_COMMAND_CATALOG.commands.find(item => item.id === row.id);
    for (const name of [row.id, row.trigger, ...(builtin?.aliases ?? [])]) {
      if (!names.has(name)) names.set(name, row);
    }
  }
  for (const row of commands.custom) names.set(row.trigger, row);
  return names;
}

function replyRow(message: ChatMessage, names: ReadonlyMap<string, CommandOptions>): ReplyRow | null {
  if (message.platform === "tiktok" || message.backlog || message.badges.includes("owner")) return null;
  const text = message.text.trim();
  const match = COMMAND.exec(text);
  if (!match) return null;
  const platform = message.platform;
  const command = names.get(match[1].toLowerCase());
  if (!command?.enabled || !command.platforms.includes(platform)) return null;
  const source = sourceFor(message, platform);
  return source ? { platform, source, id: message.id, user: message.user, text } : null;
}

export function ChatOwnerRepliesPanel({ owner, token, commands }: OwnerRepliesProps) {
  const channels = useApi<MultichatConfig>("/v1/me/preferences/multichat");
  const accounts = useApi<{ platforms: Connection[] }>("/v1/me/integrations");
  if (channels.error || accounts.error) return <div role="alert" className="space-y-2 text-caption text-warning">
    <p>Couldn’t load chat channels or send permissions.</p>
    <Button size="sm" variant="secondary" className="min-h-11" onClick={() => {
      void Promise.allSettled([channels.mutate(), accounts.mutate()]);
    }}>Retry live replies</Button>
  </div>;
  if (channels.isLoading || accounts.isLoading) return <SkeletonRows rows={2} label="Loading live replies" />;
  return <ConfiguredLiveReplies owner={owner} token={token} commands={commands} channels={channels.data} accounts={accounts.data?.platforms} />;
}

function ConfiguredLiveReplies({ owner, token, commands, channels, accounts }: OwnerRepliesProps & {
  channels: MultichatConfig | undefined; accounts: Connection[] | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  const grants = Array.isArray(accounts) ? accounts : undefined;
  const config = useMemo(() => liveConfig(channels, grants || []), [channels, grants]);
  if (!config || !Object.keys(config).length) return <p role="status" className="text-caption text-text-muted">
    Configure Twitch, Kick or YouTube chat and connect chat sending for the same account under Connected accounts.
  </p>;
  const revision = JSON.stringify([config, (grants || []).filter(canSend).map(row => [row.platform, row.connectedAt, row.platformUserName])]);
  return <LiveReplies key={`${revision}:${attempt}`} owner={owner} token={token} commands={commands} config={config}
    appearance={channels?.appearance} retry={() => setAttempt(value => value + 1)} />;
}

function useOwnerReplies(owner: string, token: string) {
  const { getToken } = useAuth();
  const runOwned = useOwnerRequestScope(owner, getToken);
  const pending = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState("");
  const remember = (key: string) => setResolved(value => new Set([...value, key].slice(-FEED_CAP)));
  const answer = async (row: ReplyRow) => {
    const key = receiptKey(row);
    if (pending.current || resolved.has(key)) return;
    pending.current = true;
    setBusy(key);
    setMessage("");
    try {
      await runOwned(owner, async (credentials, signal, assertCurrent) => {
        const result = await apiCall<ReplyResult>(credentials, REPLY_PATH, {
          method: "POST", signal, body: JSON.stringify({ token, ...row }),
        });
        assertCurrent();
        if (terminal(result.status)) remember(key);
        setMessage(result.message || OUTCOMES[result.status] || "Couldn’t send this reply. Try again.");
      }, 20_000);
    } catch (error) {
      const failure = error as { status?: number; name?: string; message?: string };
      if (failure.name === "AbortError") return;
      const unconfirmed = !failure.status || failure.status >= 500;
      if (unconfirmed) remember(key);
      setMessage(unconfirmed ? NO_RECEIPT : failure.message || "Couldn’t send this reply. Try again.");
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  return { answer, busy, message, resolved };
}

function LiveReplies({ owner, token, commands, config, appearance, retry }: OwnerRepliesProps & {
  config: MultichatConfig; appearance?: MultichatConfig["appearance"]; retry: () => void;
}) {
  const { messages, statuses } = useMultiChat({ apiBase: API_BASE, token, config, includeOfficialEvents: false });
  const names = useMemo(() => liveCommandNames(commands), [commands]);
  const rows = useMemo(() => {
    const allowed = excludeBlockedUsers(messages, blockedUserSet(sanitizeAppearance(appearance)));
    return allowed.map(message => replyRow(message, names)).filter(row => row !== null).slice(-ROW_CAP).reverse();
  }, [appearance, messages, names]);
  const { answer, busy, message, resolved } = useOwnerReplies(owner, token);
  const feedError = Object.values(statuses).some(row => row.state === "error");
  return <section aria-label="Live command replies" className="space-y-2 rounded-lg border border-border p-3">
    <p className="text-caption text-text-muted">Answer as me sends a saved command reply to the chat it came from. Only the button sends a message.</p>
    <ul aria-label="Chat connections" className="flex flex-wrap gap-3 text-caption text-text-muted">
      {(Object.keys(config) as Platform[]).map(platform => <li key={platform}>{PLATFORMS[platform]} · {statuses[platform]?.state ?? "connecting"}</li>)}
    </ul>
    {feedError ? <Button size="sm" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={retry}>Retry chat feeds</Button> : null}
    {rows.length ? <ul className="space-y-2">
      {rows.map(row => <ReplyItem key={receiptKey(row)} row={row} busy={busy} done={resolved.has(receiptKey(row))}
        answer={() => void answer(row)} />)}
    </ul> : <p role="status" className="text-caption text-text-muted">Waiting for live chat commands.</p>}
    <p role="status" className="text-caption text-text-muted">{message}</p>
  </section>;
}

function ReplyItem({ row, busy, done, answer }: { row: ReplyRow; busy: string | null; done: boolean; answer: () => void }) {
  const sending = busy === receiptKey(row);
  return <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
    <div className="min-w-0 max-w-full break-words text-caption"><span className="text-text-muted">{PLATFORMS[row.platform]} · {row.user}</span>
      <p className="font-semibold text-text">{row.text}</p>
    </div>
    <Button size="sm" variant="secondary" className="min-h-11 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
      aria-label={`Answer as me on ${PLATFORMS[row.platform]} for ${row.user}`} aria-busy={sending || undefined}
      aria-disabled={done || busy !== null} onClick={answer}>
      {sending ? "Sending…" : done ? "Reply attempted" : "Answer as me"}
    </Button>
  </li>;
}
