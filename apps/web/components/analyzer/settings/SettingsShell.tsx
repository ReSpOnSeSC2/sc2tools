"use client";

import { useState, type ReactNode } from "react";

const TABS = [
  { id: "foundation", label: "Foundation" },
  { id: "profile", label: "Profile" },
  { id: "folders", label: "Folders" },
  { id: "import", label: "Import" },
  { id: "builds", label: "Builds" },
  { id: "overlay", label: "Overlay" },
  { id: "voice", label: "Voice" },
  { id: "backups", label: "Backups" },
  { id: "misc", label: "Misc" },
] as const;

export type SettingsTabId = (typeof TABS)[number]["id"];

export function SettingsShell({
  initialTab = "foundation",
  renderTab,
}: {
  initialTab?: SettingsTabId;
  renderTab: (id: SettingsTabId) => ReactNode;
}) {
  const [active, setActive] = useState<SettingsTabId>(initialTab);
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
      <nav className="card sticky top-4 h-fit overflow-hidden">
        <ul>
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setActive(t.id)}
                className={`block w-full px-4 py-2 text-left text-sm transition ${
                  active === t.id
                    ? "bg-accent/15 text-accent"
                    : "text-text-muted hover:bg-bg-elevated hover:text-text"
                }`}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="space-y-5">{renderTab(active)}</section>
    </div>
  );
}
