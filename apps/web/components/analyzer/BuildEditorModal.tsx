"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { Card } from "@/components/ui/Card";
import {
  BuildDossier,
  type BuildDossierData,
} from "@/components/builds/BuildDossier";

/**
 * Modal that opens from the analyzer's Builds tab. Shows the same rich
 * dossier surface as the standalone /builds/[slug] page (Performance,
 * matchup/map breakdown, top opponents, build tendencies, predicted
 * strategies, median key timings, last 5 games, macro aggregate, recent
 * games table) plus the personal-notes textarea and publish-to-community
 * form.
 *
 * The build is identified by display name here (the value of the
 * `myBuild` field on stored games). When the user has saved a custom
 * build with this name, Notes/Publish PATCH against
 * `/v1/custom-builds/:name`; otherwise these controls quietly stay
 * inert because the saved-build doc doesn't exist.
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

  const [notes, setNotes] = useState("");
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notesSavedAt, setNotesSavedAt] = useState<number | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMeta, setPublishMeta] = useState({
    title: buildName,
    description: "",
    authorName: "",
  });

  // Pull the user's saved-build doc so the Notes textarea reflects the
  // current value when the modal opens. /v1/custom-builds/:slug is
  // keyed by slug; if the user saved this build with the same string
  // as both name and slug, we'll get the doc back.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const doc = await apiCall<{ notes?: string; name?: string }>(
          getToken,
          `/v1/custom-builds/${encodeURIComponent(buildName)}`,
        );
        if (cancelled) return;
        setNotes(doc.notes || "");
        if (doc.name && doc.name !== buildName) {
          setPublishMeta((m) => ({ ...m, title: doc.name || buildName }));
        }
      } catch {
        // 404 just means this isn't a saved custom build — keep notes blank.
      } finally {
        if (!cancelled) setNotesLoaded(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [buildName, getToken]);

  async function saveNotes() {
    if (saving) return;
    setSaving(true);
    setNotesSavedAt(null);
    try {
      await apiCall(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(buildName)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ notes }),
        },
      );
      bumpRev();
      setNotesSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  async function publishToCommunity() {
    if (publishing) return;
    setPublishing(true);
    setPublishMsg(null);
    try {
      const result = await apiCall<{ slug: string }>(
        getToken,
        "/v1/community/builds",
        {
          method: "POST",
          body: JSON.stringify({
            slug: buildName,
            title: publishMeta.title,
            description: publishMeta.description,
            authorName: publishMeta.authorName,
          }),
        },
      );
      setPublishMsg(`Published! /community/builds/${result.slug}`);
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Could not publish.";
      setPublishMsg(message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card flex items-center justify-between border-accent/40 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{buildName}</h2>
            <p className="text-[11px] text-text-dim">Build dossier</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs"
          >
            ✕ close
          </button>
        </div>

        <BuildDossier
          apiPath={apiPath}
          footerSlot={(data) => (
            <NotesAndPublish
              buildName={buildName}
              data={data}
              notes={notes}
              setNotes={setNotes}
              notesLoaded={notesLoaded}
              saving={saving}
              notesSavedAt={notesSavedAt}
              onSaveNotes={saveNotes}
              publishing={publishing}
              publishMsg={publishMsg}
              publishMeta={publishMeta}
              setPublishMeta={setPublishMeta}
              onPublish={publishToCommunity}
            />
          )}
        />
      </div>
    </div>
  );
}

function NotesAndPublish({
  buildName,
  data,
  notes,
  setNotes,
  notesLoaded,
  saving,
  notesSavedAt,
  onSaveNotes,
  publishing,
  publishMsg,
  publishMeta,
  setPublishMeta,
  onPublish,
}: {
  buildName: string;
  data: BuildDossierData | null;
  notes: string;
  setNotes: (n: string) => void;
  notesLoaded: boolean;
  saving: boolean;
  notesSavedAt: number | null;
  onSaveNotes: () => Promise<void>;
  publishing: boolean;
  publishMsg: string | null;
  publishMeta: { title: string; description: string; authorName: string };
  setPublishMeta: (
    next: (prev: {
      title: string;
      description: string;
      authorName: string;
    }) => { title: string; description: string; authorName: string },
  ) => void;
  onPublish: () => void;
}) {
  const savedRecently =
    notesSavedAt != null && Date.now() - notesSavedAt < 60_000;
  return (
    <div className="space-y-4">
      <Card title="Personal notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="input min-h-[120px]"
          placeholder={
            notesLoaded
              ? "Personal notes, synonyms, scouting tells…"
              : "Loading saved notes…"
          }
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-text-dim">
            {savedRecently ? "Saved." : "Notes are private to your account."}
          </span>
          <button
            type="button"
            onClick={onSaveNotes}
            className="btn"
            disabled={saving || !notesLoaded}
          >
            {saving ? "Saving…" : "Save notes"}
          </button>
        </div>
      </Card>

      <Card title="Publish to community">
        <p className="mb-2 text-xs text-text-muted">
          Share this build at <code>/community/builds/...</code>. You can
          unpublish or edit at any time. Title and description are public; your
          account name is shown unless you override it.
        </p>
        <div className="space-y-2">
          <input
            className="input"
            placeholder="Title"
            value={publishMeta.title}
            onChange={(e) =>
              setPublishMeta((m) => ({ ...m, title: e.target.value }))
            }
          />
          <textarea
            className="input min-h-[80px]"
            rows={3}
            placeholder="Description (optional)"
            value={publishMeta.description}
            onChange={(e) =>
              setPublishMeta((m) => ({
                ...m,
                description: e.target.value,
              }))
            }
          />
          <input
            className="input"
            placeholder="Display name (optional)"
            value={publishMeta.authorName}
            onChange={(e) =>
              setPublishMeta((m) => ({
                ...m,
                authorName: e.target.value,
              }))
            }
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{publishMsg}</span>
            <button
              type="button"
              className="btn"
              onClick={onPublish}
              disabled={publishing}
              title={
                data && data.totals.total === 0
                  ? `${buildName} hasn't matched any games yet`
                  : undefined
              }
            >
              {publishing ? "Publishing…" : "Publish to community"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
