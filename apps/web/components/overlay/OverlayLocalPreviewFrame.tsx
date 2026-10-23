"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LiveGamePayload } from "./types";
import { useOverlayTestLayer } from "./useOverlayTestLayer";
import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
import { defaultRandomizerConfig } from "@/lib/randomizer/config";

export function localPreviewRandomizer() {
  const config = defaultRandomizerConfig();
  config.sound.enabled = false;
  config.matchups.PvZ = { enabled: true, useCustomWeights: false, unitRandomizerEnabled: false,
    builds: [{ id: "preview-stargate", name: "Sample Stargate build", race: "Protoss", source: "catalog", weight: 1 }] };
  return config;
}

/** This frame never creates an overlay socket. Descendant feed hooks are
 * disabled by context, including demo engagement reporting. */
export function OverlayLocalPreviewFrame({ sample, children }: { sample: LiveGamePayload; children: (live: LiveGamePayload) => ReactNode }) {
  const [nonce, replay] = useState(0);
  const [scale, setScale] = useState(1);
  const frame = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale); scaleRef.current = scale;
  const { live, receiveLive } = useOverlayTestLayer("local-preview");
  useEffect(() => { receiveLive({ ...sample, testNonce: `local-preview-${nonce}` }); }, [sample, nonce, receiveLive]);
  useLayoutEffect(() => {
    const fit = () => {
      const shells = [...(frame.current?.querySelectorAll<HTMLElement>(".widget-shell") || [])];
      const elements = shells.length ? shells : frame.current?.firstElementChild ? [frame.current.firstElementChild] : [];
      const width = Math.max(0, ...elements.map((element) => element.getBoundingClientRect().width / scaleRef.current));
      setScale(width > window.innerWidth ? (window.innerWidth - 24) / width : 1);
    };
    fit(); window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [live]);
  return <OverlayPreviewContext.Provider value={true}>
    <aside className="fixed bottom-3 left-3 z-50 max-w-[50vw] rounded-lg border border-border bg-bg-surface p-3 text-caption text-text">
      <p role="status">Local preview · sample data</p>
      <p className="text-text-muted">Nothing is sent to OBS.</p>
      <button type="button" className="mt-1 min-h-11 rounded px-2 text-accent-cyan underline focus-visible:outline focus-visible:outline-2" onClick={() => replay((count) => count + 1)}>Replay sample</button>
      {!live ? <p>Preview finished.</p> : null}
    </aside>
    <div style={{ width: "100%", minHeight: "100vh", overflow: "hidden" }}><div ref={frame} style={{ position: "relative", minHeight: "100vh", width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" }}>{live ? children(live) : null}</div></div>
  </OverlayPreviewContext.Provider>;
}
