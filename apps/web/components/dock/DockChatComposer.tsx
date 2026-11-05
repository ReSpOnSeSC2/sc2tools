"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { API_BASE, boundedApiRequest, buildApiError } from "@/lib/clientApi";
import { CHAT_PLATFORMS, type ChatPlatform, type MultichatConfig } from "@/lib/multichat/types";
import { PLATFORM_META } from "@/components/overlay/widgets/MultiChatMessageList";
import { DockButton, DockInput } from "./DockControls";

type Destination = {
  platform: ChatPlatform;
  available: boolean;
  reason?: string;
  identity?: string;
  maxLength: number;
};
type Delivery = { platform: ChatPlatform; status: "sent" | "queued" | "failed" | "unknown"; message?: string };
const isPlatform = (value: unknown): value is ChatPlatform => CHAT_PLATFORMS.includes(value as ChatPlatform);

function destinations(body: unknown): Destination[] {
  const rows = (body as { platforms?: unknown })?.platforms;
  if (!Array.isArray(rows)) throw new Error("Chat sending status is unavailable.");
  return CHAT_PLATFORMS.flatMap(platform => {
    const row = rows.find(item => item && item.platform === platform);
    return row ? [{ platform, available: row.available === true,
      reason: typeof row.reason === "string" ? row.reason : undefined,
      identity: typeof row.identity === "string" ? row.identity : undefined,
      maxLength: Number.isInteger(row.maxLength) && row.maxLength > 0 ? Math.min(row.maxLength, 500) : 200 }] : [];
  });
}

function deliveryResults(body: unknown, targets: ChatPlatform[]): Delivery[] {
  const rows = (body as { results?: unknown })?.results;
  return targets.map(platform => {
    const row = Array.isArray(rows) ? rows.find(item => item?.platform === platform) : null;
    if (!row || !isPlatform(row.platform) || !["sent", "queued", "failed", "unknown"].includes(row.status)) {
      return { platform, status: "unknown", message: "Delivery unconfirmed. Check chat before sending again." };
    }
    return { platform, status: row.status, message: typeof row.message === "string" ? row.message : undefined };
  });
}

export function DockChatComposer(props: {
  token: string;
  platforms: MultichatConfig | null;
  loaded: boolean;
  onInvalid: (replaced?: boolean) => void;
}) {
  return <ActiveChatComposer key={props.token} {...props} />;
}

function ActiveChatComposer({ token, platforms, loaded, onInvalid }: {
  token: string;
  platforms: MultichatConfig | null;
  loaded: boolean;
  onInvalid: (replaced?: boolean) => void;
}) {
  const [options, setOptions] = useState<Destination[]>([]);
  const [ready, setReady] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState<ChatPlatform[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Delivery[]>([]);
  const sending = useRef(false);
  const active = useRef(true);
  const sendController = useRef<AbortController | null>(null);
  const invalidRef = useRef(onInvalid);
  invalidRef.current = onInvalid;
  const configKey = JSON.stringify(platforms);
  const url = `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/chat`;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sendController.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const controller = new AbortController();
    let fetching = false;
    setReady(false);
    const load = async () => {
      if (fetching || sending.current) return;
      fetching = true;
      try {
        const body = await boundedApiRequest(async signal => {
          const response = await fetch(url, { signal, cache: "no-store" });
          if (!response.ok) throw await buildApiError(response);
          return response.json();
        }, 20_000, controller.signal);
        if (cancelled) return;
        setOptions(destinations(body)); setReady(true); setStatusError("");
      } catch (failure) {
        if (cancelled) return;
        const detail = failure as { status?: number; code?: string };
        if (detail.status === 401) invalidRef.current(detail.code === "overlay_token_replaced");
        setReady(false); setStatusError("Couldn’t check chat sending. Refresh to try again.");
      } finally { fetching = false; }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [url, loaded, configKey, refresh]);

  const available = options.filter(option => option.available).map(option => option.platform);
  const targets = (selection ?? available).filter(platform => available.includes(platform));
  const maxLength = Math.min(500, ...options.filter(option => targets.includes(option.platform)).map(option => option.maxLength));
  const trimmed = text.trim();
  const tooLong = trimmed.length > maxLength;
  const tiktokUser = platforms?.tiktok?.enabled ? platforms.tiktok.username?.replace(/^@/, "") : undefined;
  const tiktokUrl = tiktokUser && /^[A-Za-z0-9_.]{1,24}$/.test(tiktokUser)
    ? `https://www.tiktok.com/@${encodeURIComponent(tiktokUser)}/live` : null;

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!ready || sending.current || !trimmed || tooLong || targets.length === 0) return;
    sending.current = true; setBusy(true); setResults([]);
    const submitted = [...targets];
    const controller = new AbortController(); sendController.current = controller;
    try {
      const body = await boundedApiRequest(async signal => {
        const response = await fetch(url, { method: "POST", signal, cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: trimmed, platforms: submitted }) });
        if (!response.ok) throw await buildApiError(response);
        return response.json();
      }, 60_000, controller.signal);
      if (!active.current) return;
      const deliveries = deliveryResults(body, submitted);
      setResults(deliveries);
      const failed = deliveries.filter(result => result.status === "failed").map(result => result.platform);
      if (deliveries.every(result => result.status === "sent" || result.status === "queued")) setText("");
      // A retry after partial delivery targets only the failed destinations.
      else setSelection(failed);
    } catch (failure) {
      if (!active.current) return;
      const detail = failure as { status?: number; code?: string; message?: string };
      if (detail.status === 401) invalidRef.current(detail.code === "overlay_token_replaced");
      const definitiveFailure = !!detail.status && detail.status < 500;
      const message = definitiveFailure
        ? detail.message || "Message could not be sent. Refresh chat sending status."
        : "Delivery unconfirmed. Check chat before sending again.";
      setResults(submitted.map(platform => ({ platform, status: definitiveFailure ? "failed" : "unknown", message })));
      if (!definitiveFailure) setSelection([]);
    } finally {
      sending.current = false;
      if (active.current) { setBusy(false); setRefresh(value => value + 1); }
    }
  }

  return <form onSubmit={event => void send(event)} aria-label="Send chat message" className="min-w-0 space-y-2 border-t border-border bg-bg-surface px-2 py-2">
    <fieldset disabled={busy || !ready} className="min-w-0">
      <legend className="mb-1 text-micro font-semibold text-text-muted">Send to</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        <DockButton type="button" aria-pressed={selection === null} disabled={available.length === 0 || busy || !ready}
          onClick={() => setSelection(null)} className={selection === null ? "border-accent-cyan text-accent-cyan" : ""}>All available</DockButton>
        {options.map(option => <label key={option.platform} title={option.reason || (option.identity ? `Send as ${option.identity}` : undefined)}
          className={`inline-flex min-h-8 items-center gap-1 rounded border border-border px-2 text-micro [@media(pointer:coarse)]:min-h-10 ${option.available ? "cursor-pointer text-text" : "text-text-dim"}`}>
          <input type="checkbox" aria-label={`Send to ${PLATFORM_META[option.platform].label}`} checked={targets.includes(option.platform)} disabled={!option.available}
            onChange={() => setSelection(targets.includes(option.platform) ? targets.filter(platform => platform !== option.platform) : [...targets, option.platform])}
            className="accent-accent-cyan" />{PLATFORM_META[option.platform].label}
        </label>)}
      </div>
    </fieldset>
    <div className="flex min-w-0 items-center gap-1.5">
      <DockInput aria-label="Chat message" placeholder="Type a message…" value={text} disabled={busy}
        onChange={event => { setText(event.target.value); setResults([]); }}
        onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
        aria-describedby="dock-chat-message-limit" invalid={tooLong} autoComplete="off" className="min-w-0 flex-1" />
      <DockButton type="submit" disabled={busy || !ready || !trimmed || tooLong || targets.length === 0}>{busy ? "Sending…" : "Send"}</DockButton>
    </div>
    <div id="dock-chat-message-limit" className={`text-micro ${tooLong ? "text-danger" : "text-text-dim"}`}>
      {ready ? targets.length ? `${trimmed.length}/${maxLength} · ${targets.map(platform => PLATFORM_META[platform].label).join(", ")}` : "Choose a platform to send to." : statusError || "Checking chat sending…"}
    </div>
    {results.length > 0 ? <ul aria-live="polite" className="space-y-1 text-micro">
      {results.map(result => <li key={result.platform} className={result.status === "failed" ? "text-danger" : result.status === "unknown" ? "text-warning" : "text-success"}>
        {PLATFORM_META[result.platform].label}: {result.message || (result.status === "sent" ? "Sent" : result.status === "queued" ? "Queued" : result.status === "unknown" ? "Delivery unconfirmed. Check chat before sending again." : "Couldn’t send")}
      </li>)}
    </ul> : null}
    {options.some(option => !option.available) ? <details className="text-micro text-text-muted">
      <summary className="cursor-pointer">Chat sending setup</summary>
      <ul className="mt-1 space-y-1">{options.filter(option => !option.available).map(option => <li key={option.platform}>
        {PLATFORM_META[option.platform].label}: {option.reason || "Connect chat sending in Settings."}
      </li>)}</ul>
      <a href="/settings?tab=chat" target="_blank" rel="noreferrer" className="mt-1 inline-block text-accent-cyan underline">Open Chat settings<span className="sr-only"> (opens in new tab)</span></a>
      {tiktokUrl ? <a href={tiktokUrl} target="_blank" rel="noreferrer" className="ml-2 mt-1 inline-block text-accent-cyan underline">Open TikTok LIVE<span className="sr-only"> (opens in new tab)</span></a> : null}
    </details> : null}
    <DockButton type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh sending</DockButton>
  </form>;
}
