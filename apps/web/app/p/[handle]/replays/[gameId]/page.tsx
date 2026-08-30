import type { Metadata } from "next";
import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ handle: string; gameId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle, gameId } = await params;
  return {
    title: "Shared replay analysis · SC2 Tools",
    description: "Sign in to view this shared replay analysis and macro breakdown.",
    robots: { index: false, follow: false },
    alternates: {
      canonical: `/players/${encodeURIComponent(handle)}/replays/${encodeURIComponent(gameId)}`,
    },
  };
}

/** Compatibility redirect; middleware requires sign-in before this runs. */
export default async function LegacyReplayAnalysisPage({ params }: PageProps) {
  const { handle, gameId } = await params;
  redirect(
    `/players/${encodeURIComponent(handle)}/replays/${encodeURIComponent(gameId)}`,
  );
}
