"use client";
import { useEffect, useState } from "react";

/** The last five submitted messages belong to this Dock, never another token. */
export function useSceneMessages(token?: string) {
  const key = token ? `sc2tools:dock:${token}:scene-messages` : null;
  const [saved, setSaved] = useState<{ key: string | null; messages: string[] }>({ key: null, messages: [] });
  const messages = saved.key === key ? saved.messages : [];
  useEffect(() => {
    let next: string[] = [];
    try {
      const raw: unknown = key ? JSON.parse(localStorage.getItem(key) ?? "[]") : [];
      if (Array.isArray(raw)) next = [...new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim().slice(0, 80)))].slice(0, 5);
    } catch { /* Private browsing/full storage keeps presets in this session. */ }
    setSaved({ key, messages: next });
  }, [key]);
  function update(next: string[]) {
    setSaved({ key, messages: next });
    try { if (key) localStorage.setItem(key, JSON.stringify(next)); } catch { /* Session only. */ }
  }
  return {
    messages,
    remember(message: string) { if (message) update([message, ...messages.filter((m) => m !== message)].slice(0, 5)); },
    remove(message: string) { update(messages.filter((m) => m !== message)); },
  };
}
