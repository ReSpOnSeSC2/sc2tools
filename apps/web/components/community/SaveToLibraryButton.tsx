"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2, Library } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { apiCall } from "@/lib/clientApi";
import { slugifyBuildName, type BuildRuleLike } from "@/lib/build-events";
import { SKILL_LEVELS } from "@/lib/build-rules";
import type { CustomBuild } from "@/components/builds/types";

const RULE_TYPE_SET = new Set([
  "before",
  "not_before",
  "count_max",
  "count_exact",
  "count_min",
]);
const RULE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
const SKILL_LEVEL_SET = new Set<string>(SKILL_LEVELS.map((l) => l.id));

/**
 * Sanitise the v3 `rules` array from the community snapshot down to the
 * exact shape the /v1/custom-builds validator accepts
 * ({type, name, time_lt, count?}, additionalProperties: false). The
 * snapshot was validated when the author saved it, but it round-trips
 * through Mongo + the public API so we re-check rather than trust it.
 */
function sanitizeSnapshotRules(value: unknown): BuildRuleLike[] {
  if (!Array.isArray(value)) return [];
  const out: BuildRuleLike[] = [];
  for (const raw of value) {
    if (out.length >= 30) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const type = typeof r.type === "string" ? r.type : "";
    const name = typeof r.name === "string" ? r.name : "";
    const timeLt = Math.floor(Number(r.time_lt));
    if (!RULE_TYPE_SET.has(type)) continue;
    if (!RULE_NAME_REGEX.test(name) || name.length > 80) continue;
    if (!Number.isFinite(timeLt) || timeLt < 1 || timeLt > 1800) continue;
    const rule: BuildRuleLike = { type, name, time_lt: timeLt };
    const count = Math.floor(Number(r.count));
    if (Number.isFinite(count) && count >= 0 && count <= 200) {
      rule.count = count;
    }
    out.push(rule);
  }
  return out;
}

function sanitizeNotesList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.slice(0, 280))
    .slice(0, 20);
}

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
    // Only community docs published before the `build` snapshot field
    // existed land here (publish() always stores it now). A permanently
    // disabled button looked broken; say why saving isn't possible.
    return (
      <p className="rounded-lg border border-border bg-bg-elevated/60 px-3 py-2 text-micro text-text-dim">
        This build predates library saving. If the author republishes it,
        the save option appears here.
      </p>
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
      // The snapshot is the author's full saved doc; CustomBuild only
      // types the legacy surface, so read v3 fields via a loose view.
      const snap = build as Partial<CustomBuild> & Record<string, unknown>;
      const rules = sanitizeSnapshotRules(snap.rules);
      const skillLevel =
        typeof snap.skillLevel === "string" &&
        SKILL_LEVEL_SET.has(snap.skillLevel)
          ? snap.skillLevel
          : undefined;
      const winConditions = sanitizeNotesList(snap.winConditions);
      const losesTo = sanitizeNotesList(snap.losesTo);
      const transitionsInto = sanitizeNotesList(snap.transitionsInto);
      const payload = {
        slug,
        name: baseName,
        race: build.race ?? "Random",
        vsRace: build.vsRace ?? "Any",
        description: build.description ?? "",
        notes: build.notes ?? "",
        signature: Array.isArray(build.signature) ? build.signature : [],
        perspective: build.perspective ?? "you",
        // v3 editor fields — without `rules` the forked copy loses its
        // match rules and the edit modal opens empty (0/30, no events).
        ...(rules.length > 0 ? { rules, schemaVersion: 3 } : {}),
        ...(skillLevel ? { skillLevel } : {}),
        ...(winConditions.length > 0 ? { winConditions } : {}),
        ...(losesTo.length > 0 ? { losesTo } : {}),
        ...(transitionsInto.length > 0 ? { transitionsInto } : {}),
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
          className="text-micro text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
