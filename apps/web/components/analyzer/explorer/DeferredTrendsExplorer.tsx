"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { TrendsExplorer } from "./TrendsExplorer";
import { ACTION_CLASS } from "./ExplorerPrimitives";

/** Do not compete with the existing charts until this section is approached.
 * Once activated, keep it mounted so scrolling never loses analysis settings. */
export function DeferredTrendsExplorer() {
  const [activated, setActivated] = useState(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const slot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setActivated(true);
      setIsNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      setIsNearViewport(visible);
      if (visible) setActivated(true);
    }, { rootMargin: "400px 0px" });
    if (slot.current) observer.observe(slot.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={slot} className="min-w-0">
    {activated ? <TrendsExplorer isNearViewport={isNearViewport} /> : <Card title="Explore performance">
      <div className="flex min-h-32 flex-col items-start justify-center gap-4">
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">Compare results, build execution, player groups, and repeated encounters in seven focused analyses.</p>
        <button type="button" className={ACTION_CLASS} onClick={() => { setActivated(true); setIsNearViewport(true); }}>Load analyses</button>
      </div>
    </Card>}
  </div>;
}
