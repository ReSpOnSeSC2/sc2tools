"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";

type Misc = {
  theme?: "dark" | "system";
  defaultTab?: string;
  showWizardOnNextLogin?: boolean;
  analytics?: boolean;
};

export function SettingsMisc() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<Misc>(
    "/v1/me/preferences/misc",
  );

  const [draft, setDraft] = useState<Misc>({});
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  async function save() {
    await apiCall(getToken, "/v1/me/preferences/misc", {
      method: "PUT",
      body: JSON.stringify(draft),
    });
    await mutate();
  }

  if (isLoading) return <Skeleton rows={3} />;

  return (
    <Card title="Misc preferences">
      <div className="space-y-3 text-sm">
        <label className="flex items-center justify-between gap-3 rounded border border-border bg-bg-elevated px-3 py-2">
          <span>Theme</span>
          <select
            className="input w-auto py-1 text-sm"
            value={draft.theme || "dark"}
            onChange={(e) =>
              setDraft((d) => ({ ...d, theme: e.target.value as Misc["theme"] }))
            }
          >
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-3 rounded border border-border bg-bg-elevated px-3 py-2">
          <span>Default tab</span>
          <select
            className="input w-auto py-1 text-sm"
            value={draft.defaultTab || "opponents"}
            onChange={(e) =>
              setDraft((d) => ({ ...d, defaultTab: e.target.value }))
            }
          >
            {[
              "opponents",
              "strategies",
              "trends",
              "battlefield",
              "builds",
              "ml",
              "map-intel",
            ].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-3 rounded border border-border bg-bg-elevated px-3 py-2">
          <input
            type="checkbox"
            checked={!!draft.showWizardOnNextLogin}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                showWizardOnNextLogin: e.target.checked,
              }))
            }
          />
          Show first-run wizard at next login
        </label>
        <label className="flex items-center gap-3 rounded border border-border bg-bg-elevated px-3 py-2">
          <input
            type="checkbox"
            checked={!!draft.analytics}
            onChange={(e) =>
              setDraft((d) => ({ ...d, analytics: e.target.checked }))
            }
          />
          Allow anonymous usage telemetry
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn" onClick={save}>
          Save
        </button>
      </div>
    </Card>
  );
}
