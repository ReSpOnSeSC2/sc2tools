"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, Library, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall } from "@/lib/clientApi";
import { slugifyBuildName } from "@/lib/build-events";
import type { CustomBuild } from "@/components/builds/types";

export interface SaveToLibraryButtonProps {
  /** The community build's snapshot (`build` field on the detail response). */
  build: Partial<CustomBuild> | undefined;
  /** Public title — used as the saved name. */
  title: string;
}

/**
 * SaveToLibraryButton — copies a published community build into the
 * signed-in user's private library by POSTing to /v1/custom-builds.
 *
 * The destination slug is suffixed with a short timestamp so multiple
 * "fork" saves don't collide and don't trample any existing build the
 * user owns. After save, links to /builds for follow-up editing.
 */
export function SaveToLibraryButton({
  build,
  title,
}: SaveToLibraryButtonProps) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!build) {
    return (
      <Button variant="secondary" disabled iconLeft={<Plus className="h-4 w-4" aria-hidden />}>
        Save to library
      </Button>
    );
  }

  async function handleSave() {
    if (busy || !build) return;
    setBusy(true);
    setError(null);
    try {
      const stamp = Math.floor(Date.now() / 1000).toString(36);
      const baseName = (title || build.name || "Saved build").trim();
      const slug = `${slugifyBuildName(baseName) || "build"}-${stamp}`.slice(
        0,
        80,
      );
      const payload = {
        slug,
        name: baseName,
        race: build.race ?? "Random",
        vsRace: build.vsRace ?? "Any",
        description: build.description ?? "",
        notes: build.notes ?? "",
        signature: Array.isArray(build.signature) ? build.signature : [],
        perspective: build.perspective ?? "you",
      };
      await apiCall(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(slug)}`,
        {
          method: "PUT",
          body: JSON.stringify(payload),
        },
      );
      setSavedSlug(slug);
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Save failed.";
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (savedSlug) {
    return (
      <a
        href={`/builds/${encodeURIComponent(savedSlug)}`}
        className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-success/40 bg-success/10 px-4 text-body font-semibold text-success transition-colors hover:bg-success/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        Saved — open in library
      </a>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        variant="primary"
        onClick={handleSave}
        loading={busy}
        iconLeft={<Library className="h-4 w-4" aria-hidden />}
        fullWidth
      >
        Save to my library
      </Button>
      {error ? (
        <p
          role="alert"
          className="text-[11px] text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
