"use client";

import { usePathname, useRouter } from "next/navigation";
import { Tabs } from "@/components/ui/Tabs";

/**
 * CommunityShell — Tabs wrapper for the renamed /community route.
 * Pure presentational shell so the server-rendered build list keeps
 * its data-fetching layer intact; the Leaderboard tab is its own
 * sub-route under /community/leaderboard.
 */
export function CommunityShell({
  active,
  children,
}: {
  active: "builds" | "leaderboard";
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() || "/community";

  const onChange = (next: string) => {
    if (next === "builds") router.push("/community");
    else router.push(`/community/${next}`);
  };

  // The mounted shell sits ABOVE the page-specific content; both tabs
  // are full server-rendered routes for clean direct linking.
  return (
    <div className="space-y-4" data-pathname={pathname}>
      <Tabs value={active} onValueChange={onChange}>
        <Tabs.List ariaLabel="Community sections">
          <Tabs.Trigger value="builds">Community</Tabs.Trigger>
          <Tabs.Trigger value="leaderboard">Leaderboard</Tabs.Trigger>
        </Tabs.List>
      </Tabs>
      {children}
    </div>
  );
}
