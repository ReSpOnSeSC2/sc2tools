"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { LinkButton } from "@/components/ui/Button";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { signInHref } from "@/lib/authLinks";

export function PublishCta() {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter(), resumed = useRef(false);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || resumed.current || new URLSearchParams(window.location.search).get("publish") !== "1") return;
    resumed.current = true; router.replace("/builds?publish=1");
  }, [isLoaded, isSignedIn, router]);
  const [expanded, setExpanded] = useState(false); const id = useId();
  return <div className="max-w-md space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      {isLoaded ? isSignedIn ? <LinkButton href="/builds?publish=1" variant="secondary">Publish a build</LinkButton> : <LinkButton href={signInHref("/community?publish=1")} variant="secondary">Sign in to publish</LinkButton> : null}
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)} className="min-h-11 rounded-md px-1 text-caption font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">How publishing works</button>
    </div>
    {expanded ? <div id={id} className="space-y-2 rounded-xl border border-border bg-bg-surface p-3 text-caption text-text-muted">
      <ol className="list-decimal space-y-2 pl-5"><li>Save a build to your library — from any game&apos;s build order or the editor.</li><li>Publish it with your name or anonymously.</li><li>Collect votes and update it any time.</li></ol>
      <LazyHelpLink slug="publish-community-builds" anchor="publish-from-community">Learn about publishing</LazyHelpLink>
    </div> : null}
  </div>;
}
