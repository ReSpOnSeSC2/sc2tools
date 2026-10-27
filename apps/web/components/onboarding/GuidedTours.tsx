"use client";

import { Suspense, useLayoutEffect, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import type { TourId } from "@/lib/tours";

const Controller = dynamic(() => import("./GuidedTourController").then(module => module.GuidedTourController));
type SurfaceProps = { id: TourId; ready: boolean; recordKey?: string; isCurrent?: () => boolean; className?: string; children: ReactNode };

/** A small scope boundary; tour copy, preferences, geometry and UI load only after admission. */
export function GuidedTours({ id, ready, recordKey = "surface", isCurrent, className, children }: SurfaceProps) {
  const auth = useAuth(), root = useRef<HTMLDivElement>(null);
  const owner = auth.isLoaded && auth.isSignedIn ? auth.userId : null;
  const pathname = usePathname(), identity = owner + ":" + id + ":" + recordKey + ":" + pathname + ":" + ready;
  const generation = useRef({ identity, active: true });
  if (generation.current.identity !== identity) { generation.current.active = false; generation.current = { identity, active: true }; }
  const scope = generation.current;
  const external = useRef(isCurrent); external.current = isCurrent;
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  return <div ref={root} className={className} data-tour-surface={id}>
    {owner && ready ? <Suspense fallback={null}><Controller key={identity} owner={owner} id={id} recordKey={recordKey} root={root}
      isCurrent={() => generation.current === scope && scope.active && (!external.current || external.current())} /></Suspense> : null}
    {children}</div>;
}