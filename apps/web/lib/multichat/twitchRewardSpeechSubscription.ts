import type { Socket } from "socket.io-client";
import type { ChatMessage } from "./types";

const REWARD_SPEECH_READY_ACK = "start-ack-v1";
const REWARD_RESULTS_CAP = 2000;
// Starts at the readiness probe, before the server's later 1.5s ACK wait.
const ADMISSION_MS = 1000;
const REDEMPTION_ID = /^[a-z0-9_-]{1,128}$/i;

export interface RewardSpeechHandler {
  ready: () => boolean;
  speak: (message: ChatMessage, signal: AbortSignal, startBy: number) => Promise<boolean>;
  blocked: ReadonlySet<string>;
}

export function subscribeTwitchRewardSpeech(
  socket: Socket,
  handler: () => RewardSpeechHandler,
  attempts: Map<string, Promise<boolean>>,
) {
  let lifetime = new AbortController();
  let admission: { id: string; startBy: number } | undefined;
  const onDisconnect = () => {
    admission = undefined;
    lifetime.abort();
    lifetime = new AbortController();
  };
  const onReady = (id: unknown, reply: unknown) => {
    if (typeof reply !== "function") return;
    if (typeof id !== "string" || !REDEMPTION_ID.test(id) || attempts.has(id) || !handler().ready()) {
      reply(false);
      return;
    }
    admission = { id, startBy: performance.now() + ADMISSION_MS };
    reply(REWARD_SPEECH_READY_ACK);
  };
  const onSpeech = (payload: unknown, reply: unknown) => {
    if (typeof reply !== "function") return;
    if (!payload || typeof payload !== "object") { reply(false); return; }
    const { id, name, text } = payload as Record<string, unknown>;
    if (typeof id !== "string" || !REDEMPTION_ID.test(id)) { reply(false); return; }
    let outcome = attempts.get(id);
    if (!outcome) {
      const startBy = admission?.id === id ? admission.startBy : 0;
      if (startBy) admission = undefined;
      const signal = lifetime.signal;
      outcome = Promise.resolve().then(() => {
        const { ready, speak, blocked } = handler();
        if (!startBy || performance.now() >= startBy || signal.aborted || !ready()) return false;
        if (typeof name !== "string" || !name || name.length > 120 || typeof text !== "string" || !text
          || text.length > 400 || /[\p{Cc}\p{Cf}]/u.test(text)
          || blocked.has(name.trim().toLowerCase().replace(/^@+/, ""))) return false;
        return speak({ id: `reward:${id}`, user: name, platform: "twitch", text, badges: [], atMs: Date.now() }, signal, startBy);
      }).catch(() => false);
      attempts.set(id, outcome);
      if (attempts.size > REWARD_RESULTS_CAP) {
        const oldest = attempts.keys().next().value;
        if (oldest !== undefined) attempts.delete(oldest);
      }
    }
    void outcome.then(started => reply(started));
  };
  socket.on("overlay:rewardSpeechReady", onReady);
  socket.on("overlay:rewardSpeech", onSpeech);
  socket.on("disconnect", onDisconnect);
  return () => {
    socket.off("overlay:rewardSpeechReady", onReady);
    socket.off("overlay:rewardSpeech", onSpeech);
    socket.off("disconnect", onDisconnect);
    lifetime.abort();
  };
}
