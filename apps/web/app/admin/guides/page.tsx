"use client";

import { useState } from "react";
import { guidesEnabled } from "@/lib/guides/flags";
import { ForbiddenCard } from "../components/AdminFragments";
import { GuideNotesEditor } from "./components/GuideNotesEditor";
import { GuideStatusPanel } from "./components/GuideStatusPanel";
import { GuideVideosPanel } from "./components/GuideVideosPanel";
import { selectionFor, type GuideSelection } from "./components/guidesAdminShared";
import { useGuidesAdmin } from "./components/useGuidesAdmin";

/**
 * /admin/guides — SC2 Tools Guides admin: coach's notes per build guide
 * (markdown with an exact live preview), the channel's build-order
 * videos (detected matches, global hide, add by URL, sync, per-guide
 * pin/hide) and the nightly stats run + samples backfill controls.
 *
 * Admin authority is enforced by the API (`/v1/admin/guides/*` sits
 * behind the admin router's `admin_only` gate); a 403 on any of the
 * page's reads renders the shared ForbiddenCard. The admin API works
 * whether or not the public guides flag is on, so notes and videos can
 * be prepared before launch.
 */
export default function AdminGuidesPage() {
  const { notes, status, videos, forbidden } = useGuidesAdmin();
  const [selection, setSelection] = useState<GuideSelection>(() => selectionFor());

  if (forbidden) return <ForbiddenCard />;
  return (
    <div className="space-y-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Guides</h1>
        <p className="text-text-muted">
          Coach&apos;s notes and videos for the community build guides, plus the nightly stats runs behind them. Every number on a guide comes from real games; nothing here can edit a statistic.
        </p>
        {guidesEnabled() ? null : (
          <p role="note" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-caption text-warning">
            The public guide pages are switched off in this deployment (NEXT_PUBLIC_GUIDES_ENABLED). You can still prepare notes and videos; they appear once the flag is on.
          </p>
        )}
      </header>
      <GuideNotesEditor notes={notes} selection={selection} onSelect={setSelection} />
      <GuideVideosPanel videos={videos} notes={notes} selection={selection} />
      <GuideStatusPanel status={status} />
    </div>
  );
}
