"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApi } from "@/lib/clientApi";
import type { PublicPlayerSettings } from "@/components/public-profile/types";
import { usePlayerSlugAvailability } from "./usePlayerSlugAvailability";

export const PLAYER_SECTION_FIELDS = ["showReplays", "showChannels", "showRecentForm", "showMmrHistory", "showSeasons", "showMaps"] as const;
type Draft = Pick<PublicPlayerSettings, "enabled" | typeof PLAYER_SECTION_FIELDS[number]>;

function draftOf(settings: PublicPlayerSettings): Draft {
  return Object.fromEntries([ ["enabled", settings.enabled || settings.legacyPublic], ...PLAYER_SECTION_FIELDS.map(key => [key, settings[key]]) ]) as Draft;
}

/** Mounted under an owner key; requests additionally use the shared JWT/body
 * deadline and ownership fence. Unmount/ABA completions cannot update feedback. */
export function usePublicPlayerEditor() {
  const request = useApi<PublicPlayerSettings>("/v1/me/public-profile", { revalidateOnFocus: false, revalidateOnMount: true, keepPreviousData: false }, { timeoutMs: 20_000 });
  const [baseline, setBaseline] = useState<PublicPlayerSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [prefix, setPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const lifetime = useRef({ active: true });
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => { const scope = { active: true }; lifetime.current = scope; return () => { scope.active = false; pending.current?.abort(); }; }, []);
  useEffect(() => {
    if (request.data && !baseline && !request.isValidating && !request.error) { setBaseline(request.data); setDraft(draftOf(request.data)); setPrefix(request.data.slug?.slice(0, -11) || ""); }
  }, [baseline, request.data, request.isValidating, request.error]);
  const slug = baseline?.slug ? `${prefix}${baseline.slug.slice(-11)}` : null;
  const changedSlug = Boolean(slug && slug !== baseline?.slug);
  const validPrefix = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prefix) && prefix.length <= 53;
  const availability = usePlayerSlugAvailability(slug, changedSlug && validPrefix);
  const available = !changedSlug || Boolean(!availability.isValidating && !availability.error && availability.data?.slug === slug && availability.data.available);
  async function save(create = false) {
    if (!baseline || !draft || pending.current || !lifetime.current.active) return;
    const controller = new AbortController(); pending.current = controller;
    const scope = lifetime.current;
    const current = () => scope.active && lifetime.current === scope && pending.current === controller && !controller.signal.aborted;
    setBusy(true); setFeedback(null);
    const body = create ? { enabled: false, ...Object.fromEntries(PLAYER_SECTION_FIELDS.map(key => [key, false])), slug: null, revision: baseline.revision }
      : { ...draft, slug, revision: baseline.revision };
    try {
      const next = await request.request<PublicPlayerSettings>({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      if (!current()) return;
      setBaseline(next); setDraft(draftOf(next)); setPrefix(next.slug?.slice(0, -11) || "");
      setFeedback({ error: false, text: create ? "Player link created. Your profile is still off." : "Public profile settings saved." });
      void request.mutate(next, false);
    } catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) return;
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      setFeedback({ error: true, text: code === "public_profile_conflict" ? "These settings changed elsewhere. Refresh before saving again." : code === "player_slug_unavailable" ? "That player link is unavailable. Choose another prefix." : code === "player_slug_cooldown" ? "Player links can change once every 30 days." : "Couldn't save this profile. Your changes are still here; try again." });
    } finally {
      if (pending.current === controller) { pending.current = null; if (scope.active) setBusy(false); }
    }
  }
  async function reload() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    const scope = lifetime.current;
    setBusy(true); setFeedback(null);
    try {
      const next = await request.mutate();
      if (!next || !scope.active || lifetime.current !== scope || pending.current !== controller) return;
      setBaseline(next); setDraft(draftOf(next)); setPrefix(next.slug?.slice(0, -11) || "");
    } catch {
      if (scope.active && pending.current === controller) setFeedback({ error: true, text: "Couldn't refresh saved settings. Your changes are still here." });
    } finally {
      if (pending.current === controller) { pending.current = null; if (scope.active) setBusy(false); }
    }
  }
  return { request, baseline, draft, setDraft, prefix, setPrefix, slug, busy, feedback, validPrefix, changedSlug, availability, available, save, reload };
}
