"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { ShareLinkButton } from "@/components/community/ShareLinkButton";

/**
 * SettingsPublicProfile — shows the signed-in user where their public
 * player page lives (/p/<userId>) and how to turn it on.
 *
 * The page exists only when the user has published a community build
 * under a public author name (see PublicProfileService's opt-in model),
 * so we ask the public endpoint itself rather than guessing: a 404 means
 * "not public yet", never an error to shout about.
 */
export function SettingsPublicProfile() {
  const me = useApi<{ userId?: string }>("/v1/me");
  const handle = me.data?.userId ?? null;
  const profile = useApi<unknown>(
    handle ? `/v1/public/profile/${encodeURIComponent(handle)}` : null,
    { shouldRetryOnError: false },
  );
  const path = handle ? `/p/${encodeURIComponent(handle)}` : null;
  const loading = me.isLoading || (Boolean(handle) && profile.isLoading);
  const isPublic = Boolean(profile.data) && !profile.error;
  const failed = Boolean(profile.error) && profile.error?.status !== 404;

  return (
    <Section
      title="Public profile"
      description="A shareable page with your record, matchup splits and signature builds."
    >
      {loading ? (
        <Skeleton rows={2} />
      ) : (
        <Card>
          {isPublic && path ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-caption text-text-muted">
                Your profile is live at{" "}
                <span className="break-all font-mono text-text">
                  sc2tools.com{path}
                </span>
              </p>
              <Link
                href={path}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-3 text-caption font-semibold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <ExternalLink className="h-4 w-4" aria-hidden />
                View profile
              </Link>
              <ShareLinkButton path={path} label="Copy link" />
            </div>
          ) : failed ? (
            <p role="alert" className="text-caption text-danger">
              Couldn&apos;t check your public profile right now. Try again
              later.
            </p>
          ) : (
            <p className="text-caption text-text-muted">
              Your profile turns on when you publish a build to the community
              under a public author name. Open one of your{" "}
              <Link href="/builds" className="text-accent hover:underline">
                custom builds
              </Link>{" "}
              and choose{" "}
              <span className="font-semibold text-text">Publish</span>.
            </p>
          )}
        </Card>
      )}
    </Section>
  );
}
