"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { useToastOptional } from "@/components/ui/Toast";
import { usePendingIntentResume } from "@/lib/usePendingIntentResume";
import { assignPractice, type PracticeInput } from "@/lib/practiceAssignment";
import type { GhostBuildConfig } from "@/lib/ghostBuild";
import { writeGhostPracticeCache, GHOST_SYNC_EVENT } from "@/lib/ghostSyncModel";

/** Mounted only for a matching public Practice intent after the auth return. */
export function usePracticeAuthReturn({ input, path, enabled }: { input: PracticeInput; path: string; enabled: boolean }) {
  const auth = useAuth(), { mutate } = useSWRConfig(), router = useRouter();
  const notification = useToastOptional();
  const redirected = useRef(false);
  const resumed = usePendingIntentResume("arm-ghost", path, enabled,
    payload => !input.privateBuild && payload.input.build.slug === input.build.slug && payload.input.build.name === input.build.name && payload.input.guideHref === input.guideHref,
    async (intent, context) => {
      const owner = auth.userId;
      if (!owner || !context.isCurrent()) return false;
      const result = await assignPractice(intent.payload.input, intent.payload.matchup, context.getToken, context.signal);
      if (!context.isCurrent()) return false;
      let selected = result.config;
      await mutate(["authenticated-api", owner, "/v1/me/preferences/ghost"], (current: GhostBuildConfig | undefined) => {
        if (!context.isCurrent()) return current;
        selected = (current?.revision ?? 0) > (result.config.revision ?? 0) ? current! : result.config;
        return selected;
      }, { revalidate: false });
      if (!context.isCurrent()) return false;
      writeGhostPracticeCache(owner, selected); window.dispatchEvent(new Event(GHOST_SYNC_EVENT));
      return true;
    });
  useEffect(() => {
    if (!resumed.completed || redirected.current) return;
    redirected.current = true;
    notification?.toast.success("Practice assignment saved. Your Ghost URL updates automatically.");
    router.push("/settings?tab=overlay#ghost");
  }, [resumed.completed, router, notification]);
  return resumed;
}
