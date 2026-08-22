"use client";

import { useRouter } from "next/navigation";
import { ProfileView } from "./ProfileView";

/**
 * Route wrapper: one opponent's dossier. Back always lands on the
 * opponent list, so a dossier opened from a shared link (with no
 * browser history behind it) never dead-ends.
 */
export function OpponentProfileRoute({ pulseId }: { pulseId: string }) {
  const router = useRouter();
  return (
    <ProfileView
      pulseId={pulseId}
      onBack={() => router.push("/app/opponents")}
    />
  );
}
