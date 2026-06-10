"use client";

/**
 * Save the adapted build into the user's custom builds library —
 * the exact PUT /v1/custom-builds/:slug path manual builds use, so
 * the saved build shows up in /builds, syncs across devices, and
 * feeds the replay classifier.
 */
import { useState } from "react";
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, useAuth } from "@clerk/nextjs";
import { BookmarkPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { apiCall } from "@/lib/clientApi";
import {
  CUSTOM_BUILD_PUT_PATH,
  defaultBuildName,
  toCustomBuildPayload,
} from "@/lib/optimizer/export/toCustomBuild";
import type { AdaptResult, SimRace } from "@/lib/optimizer/types";

export function ExportToBuildsButton({
  result,
  vsRace,
}: {
  result: AdaptResult | null;
  vsRace: SimRace;
}) {
  const { getToken } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);

  if (!result) return null;

  const openModal = () => {
    setName(defaultBuildName(result));
    setDescription(
      `"${result.referenceName}" re-timed from ${result.baselineProfileId} to patch ${result.profileId}.`,
    );
    setSavedSlug(null);
    setOpen(true);
  };

  const handleSave = async () => {
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const payload = toCustomBuildPayload(result, {
      name: trimmed,
      vsRace,
      description,
      isPublic,
    });
    setSaving(true);
    try {
      await apiCall<void>(getToken, CUSTOM_BUILD_PUT_PATH(payload.slug), {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSavedSlug(payload.slug);
      setOpen(false);
      toast.success("Build saved to your library", {
        description: payload.name,
      });
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Save failed.";
      toast.error("Couldn't save build", { description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Save this build">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="max-w-md text-caption text-text-muted">
          Add the re-timed opener to your custom builds library so it syncs
          across devices and your replays auto-classify against it.
        </p>
        <SignedIn>
          <div className="flex items-center gap-2">
            {savedSlug ? (
              <Link
                href={`/builds/${savedSlug}`}
                className="text-caption font-medium text-accent underline-offset-2 hover:underline"
              >
                View in library →
              </Link>
            ) : null}
            <Button
              onClick={openModal}
              iconLeft={<BookmarkPlus className="h-4 w-4" />}
            >
              Save to my builds
            </Button>
          </div>
        </SignedIn>
        <SignedOut>
          <SignInButton mode="modal">
            <Button variant="secondary">Sign in to save</Button>
          </SignInButton>
        </SignedOut>
      </div>
      <Modal
        open={open}
        onClose={saving ? () => undefined : () => setOpen(false)}
        title="Save to custom builds"
        description="The full supply-stamped order and safety report go into the build's notes."
        size="md"
        hideClose={saving}
        disableScrimClose={saving}
        footer={
          <ModalActions className="w-full justify-end">
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              Save build
            </Button>
          </ModalActions>
        }
      >
        <div className="space-y-4">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={4000}
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-text">
              Visible on your public profile
            </span>
            <Toggle
              checked={isPublic}
              onChange={setIsPublic}
              label="Visible on your public profile"
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}
