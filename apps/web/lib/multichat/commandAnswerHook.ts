"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { boundedApiRequest } from "@/lib/clientApi";
import { rankNameFor, type RankRace } from "./rankLadders";
import catalog from "./chatCommandCatalog.generated.json";
import type { ChatMessage } from "./types";
import type { CommandReply } from "./chatCommandPreferences";

export type ChatCommand = string;
export const COMMAND_THROTTLE_MS = 15_000;
export const ANSWER_TTL_MS = 12_000;
const MIN_REQUEST_GAP_MS = 5_000;
const plain = (value: string, max: number) => value.replace(/<[^>]*>/g, "").replace(/[<>\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export interface CommandAnswer { command: ChatCommand; user: string; text: string; atMs: number }

/** The server resolves aliases/custom commands and owns cooldowns. At most two
 * requests run concurrently; there is no delayed chat-message request queue. */
export function useCommandAnswers(messages: ReadonlyArray<ChatMessage>, { apiBase, token, enabled, rankRace = "protoss" }: {
  apiBase: string; token: string; enabled: boolean; rankRace?: RankRace;
}): CommandAnswer | null {
  const scope = JSON.stringify([apiBase, token, enabled, rankRace]);
  const current = useRef({ scope, generation: 0 });
  if (current.current.scope !== scope) current.current = { scope, generation: current.current.generation + 1 };
  const [state, setState] = useState<{ scope: string; answer: CommandAnswer | null }>({ scope, answer: null });
  const seen = useRef(new Set<string>()), fired = useRef(new Map<string, number>()), viewers = useRef(new Map<string, number>());
  const active = useRef(new Set<AbortController>()), mountedAt = useRef(Date.now()), initialized = useRef(false);
  const latestMessages = useRef(messages); latestMessages.current = messages;
  const sequence = useRef(0), published = useRef(0);
  useLayoutEffect(() => {
    const pending = active.current;
    if (initialized.current) seen.current = new Set(latestMessages.current.map(message => `${message.platform}:${message.id}`));
    initialized.current = true; mountedAt.current = Date.now(); fired.current.clear(); viewers.current.clear(); published.current = 0;
    setState({ scope, answer: null });
    return () => { current.current.generation++; pending.forEach(controller => controller.abort()); pending.clear(); };
  }, [scope]);
  useEffect(() => {
    for (const message of messages) {
      const key = `${message.platform}:${message.id}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (!enabled || !token || message.backlog || message.atMs < mountedAt.current - 2000) continue;
      const match = message.text.trim().match(/^!([a-z][a-z0-9_]{0,23})(?:\s+(.{0,80}))?$/i);
      if (!match) continue;
      const requested = match[1].toLowerCase(), rank = ["rank", "level", "xp"].includes(requested), command = rank ? "rank" : requested;
      if (!rank && catalog.reserved.includes(command)) continue;
      const now = Date.now(), viewer = `${message.platform}:${message.user.toLowerCase()}`;
      if (active.current.size >= 2 || now - (fired.current.get(command) ?? -Infinity) < (rank ? COMMAND_THROTTLE_MS : MIN_REQUEST_GAP_MS)
        || now - (viewers.current.get(viewer) ?? -Infinity) < MIN_REQUEST_GAP_MS) continue;
      fired.current.set(command, now); viewers.current.set(viewer, now);
      for (const ledger of [fired.current, viewers.current]) if (ledger.size > 256) ledger.delete(ledger.keys().next().value!);
      const controller = new AbortController(), generation = current.current.generation, order = ++sequence.current;
      active.current.add(controller);
      const isCurrent = () => current.current.scope === scope && current.current.generation === generation && active.current.has(controller) && !controller.signal.aborted;
      void boundedApiRequest(async signal => {
        const response = await fetch(rank
          ? `${apiBase}/v1/multichat/${encodeURIComponent(token)}/engagement/viewer?${new URLSearchParams({ platform: message.platform, user: message.user })}`
          : `${apiBase}/v1/multichat/${encodeURIComponent(token)}/command`, {
          method: rank ? "GET" : "POST", cache: "no-store", signal,
          ...(rank ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ command, argument: match[2] || "", user: plain(message.user, 80), platform: message.platform }) }),
        });
        if (!response.ok || response.status === 204) return null;
        const body = await response.json();
        if (rank) {
          if (body?.found !== true) return { command: "rank", text: "no XP yet — chat to start earning! (2 XP per message)" };
          if (![body.level, body.xp, body.oracleScore].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
          const next = body.xpToNext !== null && typeof body.xpToNext === "number" && Number.isFinite(body.xpToNext) ? rankNameFor(rankRace, body.level + 1) : null;
          return { command: "rank", text: `${rankNameFor(rankRace, body.level)} (Lv ${body.level}) · ${body.xp} XP${next ? ` — ${body.xpToNext} XP to ${next}` : " — max rank!"}${body.oracleScore > 0 ? ` · 🔮 ${body.oracleScore} oracle pts` : ""}` };
        }
        const reply = body as CommandReply;
        return reply?.status === "reply" && typeof reply.text === "string" && typeof reply.command === "string" ? { command: plain(reply.command, 24), text: plain(reply.text, 380) } : null;
      }, 15_000, controller.signal).then(reply => {
        if (!reply?.text || !isCurrent() || order < published.current) return;
        published.current = order; setState({ scope, answer: { ...reply, user: plain(message.user, 80), atMs: Date.now() } });
      }).catch(() => { /* New live messages may retry; failed work never replays. */ }).finally(() => active.current.delete(controller));
    }
    if (seen.current.size > 2000) seen.current = new Set(messages.slice(-2000).map(message => `${message.platform}:${message.id}`));
  }, [messages, enabled, apiBase, token, rankRace, scope]);
  useEffect(() => {
    if (!state.answer || state.scope !== scope) return;
    const timer = setTimeout(() => setState(previous => previous === state ? { scope, answer: null } : previous), ANSWER_TTL_MS);
    return () => clearTimeout(timer);
  }, [state, scope]);
  return state.scope === scope ? state.answer : null;
}
