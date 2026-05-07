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
  onPublished: (slug: string) => void;
}

/**
 * BuildPublishModal — confirms publish-to-community for a private
 * custom build. Captures public title / description / display name
 * and references the GDPR anonymisation policy so the user knows
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
  const [confirmAck, setConfirmAck] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(build?.name ?? "");
    setDescription(build?.description ?? "");
    setAuthorName("");
    setConfirmAck(false);
    setError(null);
    setDone(null);
    setPublishing(false);
  }, [open, build]);

  async function handlePublish() {
    if (!build || publishing) return;
    if (!confirmAck) {
      setError("Confirm the GDPR notice to publish.");
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const result = await apiCall<{ slug: string }>(
        getToken,
        "/v1/community/builds",
        {
          method: "POST",
          body: JSON.stringify({
            slug: build.slug,
            title: title.trim() || build.name,
            description: description.trim(),
            authorName: authorName.trim() || undefined,
          }),
        },
      );
      setDone(result.slug);
      onPublished(result.slug);
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
              disabled={!confirmAck}
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
          <Field label="Public title" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
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
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={4000}
              className="block w-full rounded-lg border border-border bg-bg-elevated p-3 text-body text-text placeholder:text-text-dim focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </Field>
          <Field
            label="Display name (optional)"
            hint="Override your account name for this build only."
          >
            <Input
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              maxLength={120}
              placeholder="Your community handle"
            />
          </Field>
          <label className="flex items-start gap-3 rounded-lg border border-accent-cyan/30 bg-accent-cyan/8 p-3">
            <input
              type="checkbox"
              checked={confirmAck}
              onChange={(e) => setConfirmAck(e.target.checked)}
              className="mt-1 h-4 w-4 accent-accent-cyan"
            />
            <span className="text-caption text-text-muted">
              <span className="inline-flex items-center gap-1.5 font-medium text-text">
                <ShieldCheck className="h-4 w-4 text-accent-cyan" aria-hidden />
                Anonymisation acknowledged
              </span>
              <span className="mt-1 block">
                Only the title, description, and signature you see above are
                published. Source replays, opponent identities, and personal
                notes stay private. You may unpublish at any time from the
                build's edit panel.
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
