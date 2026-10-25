"use client";

import { useState } from "react";
import Link from "next/link";
import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import { CheckCircle2, Copy, Library, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToastOptional } from "@/components/ui/Toast";
import { apiCall, useApi } from "@/lib/clientApi";
import { signInHref, signUpHref } from "@/lib/authLinks";
import { slugifyBuildName, type BuildRuleLike } from "@/lib/build-events";
import { isProxyStructureToken, SKILL_LEVELS } from "@/lib/build-rules";
import type { CustomBuild } from "@/components/builds/types";
import { publicReferenceBuildOrder } from "@/lib/buildOrderReference";

const RULE_TYPE_SET = new Set([
  "before",
  "not_before",
  "count_max",
  "count_exact",
  "count_min",
]);
const RULE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9]*$/;
const SKILL_LEVEL_SET = new Set<string>(SKILL_LEVELS.map((l) => l.id));
/** The API caps forkedFrom.version at 40 characters. */
const VERSION_MAX_CHARS = 40;

const SUCCESS_LINK_CLASS =
  "inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border-2 border-success/40 bg-success/10 px-4 text-body font-semibold text-success transition-colors hover:bg-success/15 hover:text-success focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const SECONDARY_LINK_CLASS =
  "hard-press inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border-2 border-line bg-bg-surface px-5 font-display text-body font-bold tracking-tight text-text hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const TEXT_LINK_CLASS =
  "font-semibold text-accent-cyan underline-offset-2 hover:text-accent-cyan hover:underline";

/**
 * Sanitise the v3 `rules` array from the community snapshot down to the
 * exact shape the /v1/custom-builds validator accepts
 * ({type, name, time_lt, count?, proxy?}, additionalProperties: false). The
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
    if (r.proxy === true && isProxyStructureToken(name)) rule.proxy = true;
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

function errorMessage(err: unknown, fallback: string): string {
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : fallback;
}

/** GET /v1/custom-builds?forkedFrom=… (summary view, first match only). */
interface ForkLookup {
  items: Array<{
    slug: string;
    name?: string;
    forkedFrom?: { communitySlug?: string } | null;
  }>;
  total?: number;
}

/** Older API deployments may ignore the filter; verify the provenance too. */
function existingCopy(data: ForkLookup | undefined, communitySlug: string): string | null {
  return data?.items?.find((item) => item.forkedFrom?.communitySlug === communitySlug)?.slug ?? null;
}

/** The caller's existing copy of a community build, as a list path. */
export function forkLookupPath(communitySlug: string): string {
  const query = new URLSearchParams({
    forkedFrom: communitySlug,
    limit: "1",
    view: "summary",
  });
  return `/v1/custom-builds?${query.toString()}`;
}

export interface SaveToLibraryButtonProps {
  /** The community build's snapshot (`build` field on the detail response). */
  build: Partial<CustomBuild> | undefined;
  /** Public title — used as the saved name. */
  title: string;
  /** The community build's public slug: the copy's `forkedFrom.communitySlug`. */
  communitySlug: string;
  /** The publication's version (its updatedAt, else publishedAt ISO time). */
  version?: string;
}

/**
 * SaveToLibraryButton — copies a published community build into the
 * signed-in user's private library (PUT /v1/custom-builds/:slug, create
 * only, so nothing is ever overwritten). The copy records
 * `forkedFrom: {communitySlug, version, savedAt}`; before saving, the
 * button looks for a copy with the same communitySlug and offers
 * "In your library — Open" instead of making a duplicate. "Save another
 * copy" is still there for a deliberate second copy.
 *
 * Signed-out visitors get "Sign up free to save this build" (and a sign-in
 * link), both returning to this page afterwards.
 */
export function SaveToLibraryButton(props: SaveToLibraryButtonProps) {
  if (!props.build) {
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
  const returnTo = `/community/builds/${encodeURIComponent(props.communitySlug)}`;
  return (
    <>
      <SignedIn>
        <SignedInSave {...props} build={props.build} />
      </SignedIn>
      <SignedOut>
        <div className="space-y-2">
          <Link href={signUpHref(returnTo)} className={SECONDARY_LINK_CLASS}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Sign up free to save this build
          </Link>
          <p className="text-center text-micro text-text-muted">
            Have an account?{" "}
            <Link href={signInHref(returnTo)} className={TEXT_LINK_CLASS}>
              Sign in
            </Link>
          </p>
        </div>
      </SignedOut>
    </>
  );
}

function SignedInSave({
  build,
  title,
  communitySlug,
  version,
}: SaveToLibraryButtonProps & { build: Partial<CustomBuild> }) {
  const { getToken } = useAuth();
  const toastCtx = useToastOptional();
  const lookupPath = forkLookupPath(communitySlug);
  const lookup = useApi<ForkLookup>(lookupPath, { revalidateOnFocus: false });
  const [busy, setBusy] = useState(false);
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existingSlug = savedSlug ?? existingCopy(lookup.data, communitySlug);
  const checking = !lookup.data && !lookup.error;

  /** A fresh check right before saving, so a second tab or click never duplicates. */
  async function findExistingCopy(): Promise<string | null> {
    try {
      const fresh = await apiCall<ForkLookup>(getToken, lookupPath);
      return existingCopy(fresh, communitySlug);
    } catch {
      // The lookup is a convenience; a failed check never blocks saving.
      return null;
    }
  }

  async function save(options: { allowDuplicate: boolean }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!options.allowDuplicate) {
        const found = existingSlug ?? (await findExistingCopy());
        if (found) {
          setSavedSlug(found);
          return;
        }
      }
      const stamp = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const baseName = (title || build.name || "Saved build").trim();
      // Reserve the suffix before shortening the title, including for long
      // names and two intentional copies saved within the same millisecond.
      const base = (slugifyBuildName(baseName) || "build").slice(0, 80 - stamp.length - 1);
      const slug = `${base}-${stamp}`;
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
        ...(publicReferenceBuildOrder(snap.buildOrder) ? { buildOrder: publicReferenceBuildOrder(snap.buildOrder) } : {}),
        perspective: build.perspective ?? "you",
        // v3 editor fields — without `rules` the forked copy loses its
        // match rules and the edit modal opens empty (0/30, no events).
        ...(rules.length > 0 ? { rules, schemaVersion: 3 } : {}),
        ...(skillLevel ? { skillLevel } : {}),
        ...(winConditions.length > 0 ? { winConditions } : {}),
        ...(losesTo.length > 0 ? { losesTo } : {}),
        ...(transitionsInto.length > 0 ? { transitionsInto } : {}),
        forkedFrom: {
          communitySlug,
          ...(version ? { version: version.slice(0, VERSION_MAX_CHARS) } : {}),
          savedAt: new Date().toISOString(),
        },
        // Never overwrite or revive one of the user's own builds.
        createOnly: true,
      };
      await apiCall(getToken, `/v1/custom-builds/${encodeURIComponent(slug)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setSavedSlug(slug);
      void lookup.mutate();
      toastCtx?.toast.success("Saved to your library", {
        description: (
          <Link href={`/builds/${encodeURIComponent(slug)}`} className={TEXT_LINK_CLASS}>
            Open in library
          </Link>
        ),
      });
    } catch (err: unknown) {
      setError(errorMessage(err, "Save failed."));
    } finally {
      setBusy(false);
    }
  }

  if (existingSlug) {
    return (
      <div className="space-y-2">
        <Link
          href={`/builds/${encodeURIComponent(existingSlug)}`}
          className={SUCCESS_LINK_CLASS}
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          In your library — Open
        </Link>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void save({ allowDuplicate: true })}
            disabled={busy}
            aria-busy={busy || undefined}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-caption font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden />
            {busy ? "Saving a copy…" : "Save another copy"}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-micro text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        variant="primary"
        onClick={() => void save({ allowDuplicate: false })}
        loading={busy || checking}
        iconLeft={<Library className="h-4 w-4" aria-hidden />}
        fullWidth
      >
        Save to my library
      </Button>
      <p className="text-micro text-text-muted">
        Saves a private copy you can edit. The author&apos;s page doesn&apos;t change.
      </p>
      {error ? (
        <p role="alert" className="text-micro text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
