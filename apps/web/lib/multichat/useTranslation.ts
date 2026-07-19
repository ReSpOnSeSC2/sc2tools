"use client";

// useTranslation — inline chat translation, two modes:
//
//   - "local" (the free default): on-device ML translation inside the
//     Browser Source itself via transformers.js (WASM) — see
//     lib/multichat/localTranslate. Message text NEVER leaves the OBS
//     machine; the model downloads once from the Hugging Face CDN and
//     is browser-cached. shouldTranslate gates out English/commands/
//     emote spam before any model work.
//
//   - "provider" (advanced): the original cloud relay. The provider
//     endpoint + API key live server-side in the streamer's
//     preferences; this hook only ever ships message TEXT to our own
//     API (POST /v1/multichat/:token/translate), which forwards to the
//     configured LibreTranslate-compatible service.
//
// Both modes fill the same (platform:id) → text record consumed by
// MultiChatMessageList; disabled (config null) means zero work.
//
// Provider batching: untranslated visible messages are collected per
// debounce window (max 10 per call, mirroring the relay's cap) and
// results are cached by (platform, id) for the widget's lifetime.

import { useEffect, useRef, useState } from "react";
import {
  getSharedLocalTranslator,
  shouldTranslate,
} from "./localTranslate";
import type { ChatMessage } from "./types";

const BATCH_DEBOUNCE_MS = 600;
const BATCH_MAX = 10;

/** Sanitized translate config as exposed by the token config route. */
export interface TranslateConfig {
  enabled: boolean;
  mode: "local" | "provider";
  targetLang: string;
}

export function useTranslation(
  messages: ReadonlyArray<ChatMessage>,
  args: { apiBase: string; token: string; config: TranslateConfig | null },
): Record<string, string> {
  const { apiBase, token, config } = args;
  const enabled = config?.enabled === true;
  const mode = config?.mode === "provider" ? "provider" : "local";
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const pendingRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── local mode: on-device, per message, no API calls ──
  useEffect(() => {
    if (!enabled || mode !== "local") return;
    let cancelled = false;
    for (const m of messages) {
      const key = `${m.platform}:${m.id}`;
      if (translations[key] !== undefined || pendingRef.current.has(key)) {
        continue;
      }
      pendingRef.current.add(key);
      if (!shouldTranslate(m.text)) continue; // stays pending = never retried
      void getSharedLocalTranslator()
        .translate(m.text)
        .then((t) => {
          if (cancelled || !t) return;
          setTranslations((prev) => ({ ...prev, [key]: t }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [messages, enabled, mode, translations]);

  // ── provider mode: batched relay calls (unchanged behavior) ──
  useEffect(() => {
    if (!enabled || mode !== "provider") return;
    const queue: ChatMessage[] = [];
    for (const m of messages) {
      const key = `${m.platform}:${m.id}`;
      if (translations[key] !== undefined || pendingRef.current.has(key)) {
        continue;
      }
      pendingRef.current.add(key);
      queue.push(m);
    }
    if (queue.length === 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void (async () => {
        const batch = queue.slice(-BATCH_MAX);
        try {
          const res = await fetch(
            `${apiBase}/v1/multichat/${encodeURIComponent(token)}/translate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ texts: batch.map((m) => m.text) }),
              cache: "no-store",
            },
          );
          if (!res.ok) return; // unconfigured/upstream error → plain text
          const data = (await res.json()) as { translations?: string[] };
          const out: Record<string, string> = {};
          batch.forEach((m, i) => {
            const t = data.translations?.[i]?.trim();
            // Only keep translations that actually differ — an English
            // line "translated" to itself would just add noise.
            if (t && t.toLowerCase() !== m.text.trim().toLowerCase()) {
              out[`${m.platform}:${m.id}`] = t;
            }
          });
          if (Object.keys(out).length > 0) {
            setTranslations((prev) => ({ ...prev, ...out }));
          }
        } catch {
          /* transient — later batches retry new messages */
        }
      })();
    }, BATCH_DEBOUNCE_MS);
  }, [messages, enabled, mode, apiBase, token, translations]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return enabled ? translations : {};
}
