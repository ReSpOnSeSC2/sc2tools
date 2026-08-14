"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { apiCall } from "@/lib/clientApi";
import type { CustomBuild } from "./types";

export interface BuildPublishModalProps {
  open: boolean;
  onClose: () => void;
  build: CustomBuild | null;
  onPublished: (slug: string, info?: { mirrorPending: boolean }) => void;
}

type OwnerPublicationSettings = {
  published: boolean;
  publicSlug: string | null;
  authorName: string;
  publishAnonymously: boolean;
  mirrorPending: boolean;
};

/**
 * BuildPublishModal — confirms publish-to-community for a private
 * custom build. Captures public title / description / display name
 * and references the public-data/privacy notice so the user knows
 * what's actually shared.
 */
export function BuildPublishModal({
  open,
  onClose,
  build,
  onPublished,
}: BuildPublishModalProps) {
  const { getToken } = useAuth();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [publishAnonymously, setPublishAnonymously] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityUnavailable, setIdentityUnavailable] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [confirmAck, setConfirmAck] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [mirrorPending, setMirrorPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTitle(build?.name ?? "");
    setDescription(build?.description ?? "");
    setAuthorName("");
    setPublishAnonymously(false);
    setIdentityLoading(!!build);
    setIdentityUnavailable(false);
    setIdentityError(null);
    setConfirmAck(false);
    setError(null);
    setDone(null);
    setMirrorPending(false);
    setPublishing(false);
    if (build) {
      void apiCall<OwnerPublicationSettings>(
        getToken,
        `/v1/community/my-build-publication/${encodeURIComponent(build.slug)}`,
      )
        .then((settings) => {
          if (cancelled) return;
          setAuthorName(settings.authorName || "");
          setPublishAnonymously(settings.publishAnonymously);
        })
        .catch(() => {
          if (cancelled) return;
          setIdentityUnavailable(true);
          setIdentityError(
            "Couldn't load the current author setting. Close this window and try again so an update can't change it by mistake.",
          );
        })
        .finally(() => {
          if (!cancelled) setIdentityLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
    // Parent SWR refreshes replace the build object after onPublished. Keying
    // this reset to the stable source slug keeps the success state visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, build?.slug, getToken]);

  async function handlePublish() {
    if (!build || publishing) return;
    if (!confirmAck) {
      setError("Confirm the public-data notice to publish.");
      return;
    }
    if (!publishAnonymously && !authorName.trim()) {
      setError(
        "Enter the name you want shown, or choose Post anonymously.",
      );
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await apiCall<{ slug: string; mirrorPending?: boolean }>(
        getToken,
        "/v1/community/builds",
        {
          method: "POST",
          body: JSON.stringify({
            slug: build.slug,
            title: title.trim() || build.name,
            description: description.trim(),
            authorName: publishAnonymously
              ? undefined
              : authorName.trim() || undefined,
            publishAnonymously,
          }),
        },
      );
      let badgeStillPending = !!result.mirrorPending;
      if (badgeStillPending) {
        // This owner-only read performs a best-effort repair before parent SWR
        // refreshes the private card badge.
        const settings = await apiCall<OwnerPublicationSettings>(
          getToken,
          `/v1/community/my-build-publication/${encodeURIComponent(build.slug)}`,
        ).catch(() => null);
        badgeStillPending = settings ? settings.mirrorPending : true;
      }
      setDone(result.slug);
      setMirrorPending(badgeStillPending);
      onPublished(result.slug, { mirrorPending: badgeStillPending });
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Publish failed.";
      setError(message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={publishing ? () => undefined : onClose}
      size="md"
      title="Publish to community"
      description="Make this build visible at /community/builds. You can unpublish at any time."
      hideClose={publishing}
      disableScrimClose={publishing}
      footer={
        <ModalActions className="w-full justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={publishing}
            type="button"
          >
            {done ? "Close" : "Cancel"}
          </Button>
          {done ? null : (
            <Button
              onClick={handlePublish}
              loading={publishing}
              disabled={!confirmAck || identityLoading || identityUnavailable}
              type="button"
            >
              Publish build
            </Button>
          )}
        </ModalActions>
      }
    >
      {done ? (
        <div className="space-y-3">
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-caption text-success"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Published successfully.
          </div>
          <p className="text-caption text-text-muted">
            Your build is live at the URL below. The community listing
            re-fetches on every page load, so it will appear there
            within seconds.
          </p>
          {mirrorPending ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning">
              The Community listing is live. Your private-library Published
              badge is still syncing. Reopen the editor to retry the sync.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/community/builds/${done}`}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-2 text-caption font-semibold text-accent-cyan hover:bg-accent-cyan/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              View on the community page
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </Link>
            <Link
              href="/community"
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-caption font-semibold text-text hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Browse all community builds
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {identityLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-border bg-bg-elevated/50 px-3 py-2 text-caption text-text-muted"
            >
              Loading your current Community author settingâ€¦
            </div>
          ) : null}
          {identityError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
            >
              {identityError}
            </div>
          ) : null}
          <Field label="Public title" required>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              maxLength={120}
              placeholder="Stalker Glaive Adept Timing"
            />
          </Field>
          <Field
            label="Description"
            hint="What scouting tells signal this opener? What does it punish?"
          >
            <textarea
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setError(null);
              }}
              rows={4}
              maxLength={4000}
              className="block w-full rounded-lg border border-border bg-bg-elevated p-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
          <Field
            label="Name shown publicly"
            hint={
              publishAnonymously
                ? "Hidden while Post anonymously is selected."
                : "Your profile name is filled in by default. You can use a different community handle for this build."
            }
          >
            <Input
              value={authorName}
              onChange={(e) => {
                setAuthorName(e.target.value);
                setError(null);
              }}
              maxLength={80}
              placeholder="Your community handle"
              disabled={publishAnonymously || identityLoading}
            />
          </Field>
          <label className="flex min-h-[48px] cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-elevated/50 p-3">
            <input
              type="checkbox"
              checked={publishAnonymously}
              onChange={(e) => {
                setPublishAnonymously(e.target.checked);
                setError(null);
              }}
              disabled={identityLoading}
              className="mt-0.5 h-5 w-5 flex-none accent-accent-cyan"
            />
            <span className="text-caption text-text-muted">
              <span className="block font-medium text-text">
                Post anonymously
              </span>
              <span className="block">
                Leave this off to show the name above. Turn it on only when
                you want this build published without an author profile link.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border border-accent-cyan/30 bg-accent-cyan/8 p-3">
            <input
              type="checkbox"
              checked={confirmAck}
              onChange={(e) => {
                setConfirmAck(e.target.checked);
                setError(null);
              }}
              className="mt-1 h-4 w-4 accent-accent-cyan"
            />
            <span className="text-caption text-text-muted">
              <span className="inline-flex items-center gap-1.5 font-medium text-text">
                <ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden />
                Public data acknowledged
              </span>
              <span className="mt-1 block">
                The title, description, build metadata, signature, and the
                author choice shown above are published. Source replays,
                opponent identities, and personal notes stay private. You may
                unpublish at any time from the build's edit panel.
              </span>
            </span>
          </label>
          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
            >
              {error}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
