"use client";

/**
 * DockBuildVote — "Chat picks the build": tap up to 3 of your saved
 * builds (real win-rates shown from your replay history), start the
 * vote, and chat decides with !1/!2/!3 through the existing poll
 * widget. Reuses the whole poll pipeline — this panel only assembles
 * the poll (question, options = build names, meta.winRates) and
 * hands it to the same studio POST the Poll panel uses.
 */

import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { DockButton } from "./DockClient";

interface SlimBuild {
  slug: string;
  name: string;
  race?: string;
  vsRace?: string;
  total: number;
  winRate: number | null;
}

export function DockBuildVote({
  token,
  busy,
  pollActive,
  onPost,
}: {
  token: string;
  busy: boolean;
  /** True while any poll is running — one poll at a time. */
  pollActive: boolean;
  onPost: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [builds, setBuilds] = useState<SlimBuild[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/v1/multichat/${encodeURIComponent(token)}/builds`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { builds?: SlimBuild[] };
        setBuilds(Array.isArray(body.builds) ? body.builds.slice(0, 50) : []);
      } catch {
        /* transient — panel just shows the empty hint */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggle = (slug: string) =>
    setPicked((prev) =>
      prev.includes(slug)
        ? prev.filter((s) => s !== slug)
        : prev.length >= 3
          ? prev
          : [...prev, slug],
    );

  const start = async () => {
    const chosen = picked
      .map((slug) => builds.find((b) => b.slug === slug))
      .filter((b): b is SlimBuild => Boolean(b));
    if (chosen.length < 2) return;
    const winRates: Record<string, number> = {};
    for (const b of chosen) {
      if (b.winRate !== null) winRates[b.name] = Math.round(b.winRate * 100) / 1;
    }
    await onPost({
      poll: {
        question: "Chat picks the build!",
        options: chosen.map((b) => b.name),
        status: "open",
        meta: { kind: "build", winRates },
      },
    });
    setPicked([]);
  };

  if (loaded && builds.length === 0) {
    return (
      <p className="text-caption text-text-dim">
        No saved builds yet — create builds in your library first, then
        let chat pick which one you play.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-caption text-text-dim">
        Pick 2–3 builds; chat votes with <b>!1</b>/<b>!2</b>/<b>!3</b> on
        the Chat poll widget.
      </p>
      <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
        {builds.map((b) => {
          const on = picked.includes(b.slug);
          return (
            <li key={b.slug}>
              <button
                type="button"
                onClick={() => toggle(b.slug)}
                className={`flex w-full min-w-0 items-baseline gap-2 rounded-md border px-2 py-1 text-left text-caption ${
                  on
                    ? "border-accent bg-accent/10 text-text"
                    : "border-border bg-bg-elevated text-text-muted hover:text-text"
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {b.name}
                </span>
                {b.race ? (
                  <span className="text-micro text-text-dim">
                    {b.race}v{b.vsRace ?? "X"}
                  </span>
                ) : null}
                <span className="text-micro tabular-nums text-text-dim">
                  {b.winRate !== null
                    ? `${Math.round(b.winRate * 100)}% · ${b.total}g`
                    : "no games"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <DockButton
          disabled={busy || picked.length < 2 || pollActive}
          onClick={() => void start()}
        >
          🗳 Start build vote
        </DockButton>
        {pollActive ? (
          <span className="text-micro text-text-dim">
            Close the running poll first
          </span>
        ) : null}
      </div>
    </div>
  );
}
