import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PageProps {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { handle } = await params;
  return {
    title: "Shared replays · SC2 Tools",
    description: "This replay archive has moved to its player page.",
    robots: { index: false, follow: false },
    alternates: {
      canonical: `/players/${encodeURIComponent(handle)}/replays`,
    },
  };
}

/** Compatibility redirect for links created before player replay URLs. */
export default async function LegacyPublicReplaysPage({ params, searchParams }: PageProps) {
  const [{ handle }, query] = await Promise.all([params, searchParams]);
  const suffix = queryString(query);
  redirect(`/players/${encodeURIComponent(handle)}/replays${suffix}`);
}

function queryString(raw: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (typeof value === "string") {
      params.set(key, value);
    }
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}
