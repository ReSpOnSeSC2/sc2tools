"use client";

import { useCallback, useRef, useState } from "react";
import { defaultOverlayProfile, normalizeOverlayProfile, type OverlayProfile } from "./overlayProfile";
import { decodeOverlayTheme, themeToCssVars } from "./overlayTheme";

export type OverlayProfileConfig = { profile?: unknown; profileRevision?: number };

/** Reuse each surface's socket. Older connect snapshots cannot undo a live save. */
export function useOverlayProfile(token: string, themeParam?: string | null) {
  const owner = useRef({ token });
  if (owner.current.token !== token) owner.current = { token };
  const scope = owner.current;
  const accepted = useRef<{ scope: typeof scope; revision: number } | null>(null);
  const [snapshot, setSnapshot] = useState<{ scope: typeof scope; revision: number; profile: OverlayProfile } | null>(null);
  const profile = snapshot?.scope === scope ? snapshot.profile : defaultOverlayProfile();
  const optionsRef = useRef(profile.widgetOptions);
  optionsRef.current = profile.widgetOptions;
  const receiveProfile = useCallback((message: OverlayProfileConfig) => {
    if (owner.current !== scope || !message || !Object.hasOwn(message, "profile")) return;
    const revision = message.profileRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const next = normalizeOverlayProfile(message.profile);
    if (accepted.current?.scope === scope && accepted.current.revision >= revision) return;
    accepted.current = { scope, revision };
    // A live payload can follow config in the same socket turn.
    optionsRef.current = next.widgetOptions;
    setSnapshot({ scope, revision, profile: next });
  }, [scope]);
  // Presence wins, including ?theme= and malformed legacy overrides.
  const theme = themeParam != null ? decodeOverlayTheme(themeParam) : profile.theme;
  return { profile, theme, themeVars: themeToCssVars(theme), optionsRef, receiveProfile };
}
