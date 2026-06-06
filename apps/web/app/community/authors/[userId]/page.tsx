import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getJson } from "@/lib/serverApi";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { AuthorProfile } from "@/components/community/AuthorProfile";
import type { CommunityAuthorProfile } from "@/components/community/types";

/**
 * Public author profile route.
 *
 * Resolution: GET /v1/community/authors/:userId returns 200 with the
 * aggregate when the author has at least one published build with a
 * non-empty `authorName`. Any other state (no builds, all anonymous,
 * or unknown user id) returns 404, which we surface as a NotFound
 * panel rather than the global 404 — the wording stays neutral so a
 * user who deliberately stays anonymous isn't outed by the message.
 */
export const revalidate = 300;

interface PageParams {
  params: Promise<{ userId: string }>;
}

export async function generateMetadata({ params }: PageParams) {
  const { userId } = await params;
  const profile = await getJson<CommunityAuthorProfile>(
    `/v1/community/authors/${encodeURIComponent(userId)}`,
  );
  if (!profile) {
    return {
      title: "Author profile — SC2 Tools",
      description: "This SC2 Tools community profile is private or doesn't exist.",
      robots: { index: false, follow: false },
    };
  }
  const description =
    profile.totalBuilds === 1
      ? `1 published build by ${profile.displayName}.`
      : `${profile.totalBuilds} published builds by ${profile.displayName}.`;
  return {
    title: `${profile.displayName} — SC2 Tools community`,
    description,
    openGraph: {
      title: `${profile.displayName} — SC2 Tools community`,
      description,
      images: [{ url: "/og.jpg", width: 1200, height: 630 }],
    },
  };
}

export default async function CommunityAuthorPage({ params }: PageParams) {
  const { userId } = await params;
  const profile = await getJson<CommunityAuthorProfile>(
    `/v1/community/authors/${encodeURIComponent(userId)}`,
  );
  if (!profile) {
    return <NotFoundPanel />;
  }
  return <AuthorProfile profile={profile} />;
}

function NotFoundPanel() {
  return (
    <article className="space-y-6">
      <Link
        href="/community"
        className="inline-flex min-h-[44px] items-center gap-1.5 text-caption font-medium text-text-muted hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to community
      </Link>
      <Card>
        <EmptyStatePanel
          size="lg"
          title="This profile is private or doesn't exist"
          description="Either the author hasn't declared a public name on any of their builds, or the profile id doesn't match an SC2 Tools account."
          action={
            <Link
              href="/community"
              className="inline-flex min-h-[44px] items-center gap-2 hard-press rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Browse community builds
            </Link>
          }
        />
      </Card>
    </article>
  );
}
