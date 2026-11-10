"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/lib/clientApi";
import { applyAuthorUpdate, dismissAuthorUpdate } from "@/lib/buildLibrary";
import type { CustomBuild } from "../types";
import { RulesDiff } from "./RulesDiff";

interface Publication {
  slug: string;
  title?: string;
  version?: number;
  build?: Record<string, unknown>;
}

/**
 * "Review update" for a build saved from Community whose author has
 * published a newer version: what changed in the rules, then "Apply
 * update" (your notes, skill level and name stay; the replaced version is
 * kept in History) or "Dismiss" (keep your copy as it is).
 */
export function ReviewUpdateModal({
  open,
  build,
  version,
  onClose,
  onDone,
}: {
  open: boolean;
  build: CustomBuild;
  version: number;
  onClose: () => void;
  onDone: (message: string, error?: boolean) => void;
}) {
  const { getToken } = useAuth();
  const communitySlug = build.forkedFrom?.communitySlug ?? null;
  const publication = useApi<Publication>(open && communitySlug ? `/v1/community/builds/${encodeURIComponent(communitySlug)}` : null, { revalidateOnFocus: false });
  const [busy, setBusy] = useState<"apply" | "dismiss" | null>(null);

  const act = async (kind: "apply" | "dismiss") => {
    setBusy(kind);
    try {
      if (kind === "apply") await applyAuthorUpdate(getToken, build.slug);
      else await dismissAuthorUpdate(getToken, build.slug, version);
      onDone(kind === "apply" ? `Updated “${build.name}” to the author's latest version` : "Kept your copy as it is");
      onClose();
    } catch (err) {
      onDone(err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "That didn't work. Try again.", true);
    } finally {
      setBusy(null);
    }
  };

  const author = publication.data?.build ?? null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review update"
      description="The author changed this build since you saved it. Applying keeps your notes, skill level and name."
      size="lg"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => void act("dismiss")} loading={busy === "dismiss"} disabled={busy !== null}>Dismiss</Button>
          <Button onClick={() => void act("apply")} loading={busy === "apply"} disabled={busy !== null || !author}>Apply update</Button>
        </div>
      )}
    >
      {publication.error ? (
        <p role="alert" className="text-caption text-danger">The author's build couldn't load. It may have been removed from Community.</p>
      ) : !author ? (
        <p role="status" className="text-caption text-text-muted">Loading the author's version…</p>
      ) : (
        <div className="space-y-3">
          <RulesDiff from={build} to={author} fields={["race", "vsRace", "description"]} fromLabel="Your copy" toLabel="Author's version" />
          {communitySlug ? (
            <Link href={`/community/builds/${encodeURIComponent(communitySlug)}`} className="inline-flex min-h-11 items-center text-caption font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              Open the community build
            </Link>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
