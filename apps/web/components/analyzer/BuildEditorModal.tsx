"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { Card } from "@/components/ui/Card";
import { BuildDossier } from "@/components/builds/BuildDossier";
import { BuildPublishModal } from "@/components/builds/BuildPublishModal";
import type { CustomBuild } from "@/components/builds/types";

/**
 * Modal that opens from the analyzer's Builds tab. Shows the same rich
 * dossier surface as the standalone /builds/[slug] page plus a
 * personal-notes editor and a publish-to-community action.
 *
 * The Builds tab aggregates games by display name (`myBuild`), NOT by
 * slug, so this modal first resolves whether that label corresponds to a
 * build in the user's library (`GET /v1/custom-builds`, matched by name
 * then slug). Only a *saved* build carries the rules/snapshot needed to
 * publish or to hold notes, so the controls adapt:
 *   - saved   → notes PUT against the real slug; "Publish" opens the same
 *               BuildPublishModal the /builds library uses (slug-keyed,
 *               with the anonymisation acknowledgement + public title).
 *   - unsaved → an explainer pointing at "Save as new build" — an
 *               auto-classified label has no definition to share.
 *
 * This replaces the previous implementation, which addressed builds by
 * display name and published with `slug: buildName`. The community API is
 * slug-keyed, so that always 404'd ("build_not_found"); its notes save
 * also PATCHed a route that doesn't exist. Both are fixed here.
 */
export function BuildEditorModal({
  buildName,
  onClose,
}: {
  buildName: string;
  onClose: () => void;
}) {
  const { getToken } = useAuth();
  const { bumpRev } = useFilters();
  const apiPath = `/v1/builds/${encodeURIComponent(buildName)}`;

  const [saved, setSaved] = useState<CustomBuild | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [notesSavedAt, setNotesSavedAt] = useState<number | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);

  // Resolve the clicked label to a saved custom build, if the user owns
  // one by that name. Falls back to a slug match for legacy builds whose
  // name and slug coincided.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLookupDone(false);
      try {
        const resp = await apiCall<{ items: CustomBuild[] }>(
          getToken,
          "/v1/custom-builds",
        );
        if (cancelled) return;
        const items = Array.isArray(resp.items) ? resp.items : [];
        const match =
          items.find((b) => b.name === buildName) ||
          items.find((b) => b.slug === buildName) ||
          null;
        setSaved(match);
        setNotes(match?.notes || "");
      } catch {
        if (!cancelled) setSaved(null);
      } finally {
        if (!cancelled) setLookupDone(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [buildName, getToken]);

  async function saveNotes() {
    if (saving || !saved) return;
    setSaving(true);
    setNotesError(null);
    setNotesSavedAt(null);
    try {
      // Re-PUT the saved doc with updated notes. Share/visibility flags
      // are intentionally omitted: the server only reconciles community
      // state when a share flag is present, so a notes edit can never
      // accidentally publish or unpublish the build.
      const { isPublic: _ip, shareWithCommunity: _sc, ...rest } = saved as
        CustomBuild & { shareWithCommunity?: boolean };
      void _ip;
      void _sc;
      await apiCall(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(saved.slug)}`,
        { method: "PUT", body: JSON.stringify({ ...rest, notes }) },
      );
      setSaved((s) => (s ? { ...s, notes } : s));
      bumpRev();
      setNotesSavedAt(Date.now());
    } catch (err: unknown) {
      setNotesError(extractMessage(err) || "Couldn't save notes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
        onClick={onClose}
      >
        <div
          className="w-full max-w-4xl space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="rounded-xl border border-border bg-bg-surface flex items-center justify-between px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{buildName}</h2>
              <p className="text-micro text-text-dim">Build dossier</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-2 hard-press rounded-full px-5 py-[0.55rem] font-display font-bold border-2 border-line bg-bg-surface text-text hover:bg-bg-elevated text-xs"
            >
              ✕ close
            </button>
          </div>

          <BuildDossier
            apiPath={apiPath}
            footerSlot={() => (
              <NotesAndPublish
                saved={saved}
                lookupDone={lookupDone}
                notes={notes}
                setNotes={setNotes}
                saving={saving}
                notesSavedAt={notesSavedAt}
                notesError={notesError}
                onSaveNotes={saveNotes}
                onOpenPublish={() => setPublishOpen(true)}
              />
            )}
          />
        </div>
      </div>

      {/* Rendered as a sibling (not inside the click-to-close scrim) so
          interacting with it never dismisses the dossier behind it. */}
      {saved ? (
        <BuildPublishModal
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          build={saved}
          onPublished={() => {
            setSaved((s) => (s ? { ...s, isPublic: true } : s));
            bumpRev();
          }}
        />
      ) : null}
    </>
  );
}

function NotesAndPublish({
  saved,
  lookupDone,
  notes,
  setNotes,
  saving,
  notesSavedAt,
  notesError,
  onSaveNotes,
  onOpenPublish,
}: {
  saved: CustomBuild | null;
  lookupDone: boolean;
  notes: string;
  setNotes: (n: string) => void;
  saving: boolean;
  notesSavedAt: number | null;
  notesError: string | null;
  onSaveNotes: () => Promise<void>;
  onOpenPublish: () => void;
}) {
  const savedRecently =
    notesSavedAt != null && Date.now() - notesSavedAt < 60_000;

  return (
    <div className="space-y-4">
      <Card title="Personal notes">
        {saved ? (
          <>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-[0.55rem] text-text transition-colors placeholder:text-text-dim focus:border-accent focus:outline-none min-h-[120px]"
              placeholder="Personal notes, synonyms, scouting tells…"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-micro text-text-dim">
                {savedRecently
                  ? "Saved."
                  : "Notes are private to your account."}
              </span>
              <button
                type="button"
                onClick={onSaveNotes}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors bg-accent text-bg hover:bg-accent-hover disabled:opacity-60"
                disabled={saving}
              >
                {saving ? "Saving…" : "Save notes"}
              </button>
            </div>
            {notesError ? (
              <p role="alert" className="mt-2 text-micro text-danger">
                {notesError}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-caption text-text-muted">
            {lookupDone
              ? "This opener isn’t in your library yet, so there’s nowhere to keep private notes. Open a replay that uses it and choose “Save as new build” — notes then live on that build."
              : "Checking your library…"}
          </p>
        )}
      </Card>

      <Card title="Publish to community">
        {saved ? (
          <div className="space-y-2">
            <p className="text-xs text-text-muted">
              Share this build at <code>/community/builds/…</code>. You choose
              the public title, description, and display name, and can unpublish
              at any time.
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onOpenPublish}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-[0.55rem] font-semibold transition-colors bg-accent text-bg hover:bg-accent-hover"
              >
                {saved.isPublic
                  ? "Update community listing"
                  : "Publish to community"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-caption text-text-muted">
            {lookupDone
              ? "Only saved custom builds can be published. Save this opener to your library first (open a replay → “Save as new build”), then publish it from here or your library."
              : "Checking your library…"}
          </p>
        )}
      </Card>
    </div>
  );
}

function extractMessage(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return null;
}
