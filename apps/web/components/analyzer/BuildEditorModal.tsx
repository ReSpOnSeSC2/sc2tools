"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { useFilters } from "@/lib/filterContext";
import { fmtAgo, pct1, wrColor } from "@/lib/format";
import { Card, EmptyState, Skeleton } from "@/components/ui/Card";

type BuildDetail = {
  name: string;
  notes?: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  matchups?: { matchup: string; wins: number; losses: number; total: number; winRate: number }[];
  recentGames?: {
    gameId: string;
    date: string;
    map: string;
    opponent: string;
    result: "win" | "loss";
  }[];
};

/**
 * Modal for inspecting a build, editing its notes / synonyms (if it's
 * a custom one), and jumping into recent games.
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
  const { data, isLoading, mutate } = useApi<BuildDetail>(
    `/v1/builds/${encodeURIComponent(buildName)}`,
  );

  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMeta, setPublishMeta] = useState({
    title: "",
    description: "",
    authorName: "",
  });
  useEffect(() => {
    if (data) {
      setNotes(data.notes || "");
      setPublishMeta((m) => ({
        ...m,
        title: m.title || data.name || buildName,
      }));
    }
  }, [data, buildName]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await apiCall(
        getToken,
        `/v1/custom-builds/${encodeURIComponent(buildName)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ notes }),
        },
      );
      await mutate();
      bumpRev();
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
    } catch (err: any) {
      setPublishMsg(err?.message || "Could not publish.");
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
        className="w-full max-w-3xl space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card flex items-center justify-between border-accent/40 px-4 py-3">
          <h2 className="text-base font-semibold">{buildName}</h2>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs"
          >
            ✕ close
          </button>
        </div>

        {isLoading ? (
          <Skeleton rows={4} />
        ) : !data ? (
          <Card>
            <EmptyState title="Build not found" />
          </Card>
        ) : (
          <>
            <Card title="Performance">
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                <Stat label="Games" value={data.total} />
                <Stat label="Wins" value={data.wins} color="#3ec07a" />
                <Stat label="Losses" value={data.losses} color="#ff6b6b" />
                <Stat
                  label="Win rate"
                  value={pct1(data.winRate)}
                  color={wrColor(data.winRate, data.total)}
                />
              </div>
            </Card>

            <Card title="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={4}
                className="input min-h-[120px]"
                placeholder="Personal notes, synonyms, scouting tells…"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={save}
                  className="btn"
                  disabled={saving}
                >
                  {saving ? "Saving…" : "Save notes"}
                </button>
              </div>
            </Card>

            {data.matchups && data.matchups.length > 0 && (
              <Card title="By matchup">
                <table className="w-full text-sm">
                  <tbody>
                    {data.matchups.map((m) => (
                      <tr key={m.matchup} className="border-t border-border">
                        <td className="px-3 py-1.5">{m.matchup}</td>
                        <td className="px-3 py-1.5 text-right">
                          {m.wins}W &ndash; {m.losses}L
                        </td>
                        <td
                          className="px-3 py-1.5 text-right tabular-nums"
                          style={{ color: wrColor(m.winRate, m.total) }}
                        >
                          {pct1(m.winRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}

            <Card title="Publish to community">
              <p className="mb-2 text-xs text-text-muted">
                Share this build at <code>/community/builds/...</code>. You
                can unpublish or edit at any time. Title and description are
                public; your account name is shown unless you override it.
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
                  <span className="text-xs text-text-muted">
                    {publishMsg}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={publishToCommunity}
                    disabled={publishing}
                  >
                    {publishing ? "Publishing…" : "Publish to community"}
                  </button>
                </div>
              </div>
            </Card>

            {data.recentGames && data.recentGames.length > 0 && (
              <Card title="Recent games">
                <ul className="divide-y divide-border text-sm">
                  {data.recentGames.map((g) => (
                    <li
                      key={g.gameId}
                      className="flex items-center justify-between px-1 py-2"
                    >
                      <span>
                        <span
                          className="font-mono text-xs"
                          style={{
                            color: g.result === "win" ? "#3ec07a" : "#ff6b6b",
                          }}
                        >
                          {g.result.toUpperCase()}
                        </span>{" "}
                        vs {g.opponent || "—"} · {g.map}
                      </span>
                      <span className="text-xs text-text-dim">
                        {fmtAgo(g.date)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded border border-border bg-bg-elevated p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">
        {label}
      </div>
      <div
        className="mt-1 text-lg font-semibold tabular-nums"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
