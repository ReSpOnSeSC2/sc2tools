"use client";

import { useState, type ReactNode } from "react";
import {
  ServerCog,
  UserRound,
  FolderOpen,
  Download,
  ListTree,
  MonitorPlay,
  Volume2,
  Database,
  Settings2,
} from "lucide-react";
import { Tabs } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  SettingsContextProvider,
  useSettingsContext,
} from "./SettingsContext";

type IconComponent = typeof ServerCog;

interface TabDef {
  id: SettingsTabId;
  label: string;
  Icon: IconComponent;
}

const TABS: ReadonlyArray<TabDef> = [
  { id: "foundation", label: "Foundation", Icon: ServerCog },
  { id: "profile", label: "Profile", Icon: UserRound },
  { id: "folders", label: "Folders", Icon: FolderOpen },
  { id: "import", label: "Import", Icon: Download },
  { id: "builds", label: "Builds", Icon: ListTree },
  { id: "overlay", label: "Overlay", Icon: MonitorPlay },
  { id: "voice", label: "Voice", Icon: Volume2 },
  { id: "backups", label: "Backups", Icon: Database },
  { id: "misc", label: "Misc", Icon: Settings2 },
];

export type SettingsTabId =
  | "foundation"
  | "profile"
  | "folders"
  | "import"
  | "builds"
  | "overlay"
  | "voice"
  | "backups"
  | "misc";

export interface SettingsShellProps {
  initialTab?: SettingsTabId;
  renderTab: (id: SettingsTabId) => ReactNode;
}

export function SettingsShell({
  initialTab = "foundation",
  renderTab,
}: SettingsShellProps) {
  return (
    <SettingsContextProvider>
      <SettingsShellInner initialTab={initialTab} renderTab={renderTab} />
    </SettingsContextProvider>
  );
}

function SettingsShellInner({
  initialTab,
  renderTab,
}: Required<SettingsShellProps>) {
  const [active, setActive] = useState<SettingsTabId>(initialTab);
  const [pending, setPending] = useState<SettingsTabId | null>(null);
  const ctx = useSettingsContext();

  const requestSwitch = (next: string) => {
    const target = next as SettingsTabId;
    if (target === active) return;
    if (ctx.isDirty(active)) {
      setPending(target);
      return;
    }
    setActive(target);
  };

  const confirmDiscard = () => {
    if (pending) {
      setActive(pending);
      setPending(null);
    }
  };

  return (
    <>
      <Tabs
        value={active}
        onValueChange={requestSwitch}
        orientation="vertical"
        className="lg:grid-cols-[240px_1fr]"
      >
        {/* Mobile bar — horizontal scroll above content */}
        <div className="lg:hidden">
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="horizontal"
            className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
          >
            {TABS.map((t) => (
              <MobileTabTrigger
                key={t.id}
                tab={t}
                active={active === t.id}
                dirty={ctx.isDirty(t.id)}
                onActivate={() => requestSwitch(t.id)}
              />
            ))}
          </div>
        </div>

        {/* Desktop sidebar */}
        <Tabs.List ariaLabel="Settings sections" className="hidden lg:flex">
          {TABS.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id}>
              <span className="inline-flex w-full items-center gap-2.5">
                <t.Icon
                  className="h-4 w-4 flex-shrink-0"
                  aria-hidden
                />
                <span className="flex-1 truncate text-left">{t.label}</span>
                {ctx.isDirty(t.id) ? (
                  <span
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                    className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-cyan"
                  />
                ) : null}
              </span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        {TABS.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="space-y-5 pb-24">
            {renderTab(t.id)}
          </Tabs.Content>
        ))}
      </Tabs>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmDiscard}
        title="Discard unsaved changes?"
        description="You have edits on this panel that haven't been saved. Switch tabs anyway?"
        confirmLabel="Discard & switch"
        cancelLabel="Stay on this tab"
        intent="danger"
      />
    </>
  );
}

function MobileTabTrigger({
  tab,
  active,
  dirty,
  onActivate,
}: {
  tab: TabDef;
  active: boolean;
  dirty: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onActivate}
      className={[
        "relative inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 text-caption transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        active
          ? "border-accent/40 bg-accent/15 text-accent"
          : "border-border bg-bg-surface text-text-muted hover:bg-bg-elevated hover:text-text",
      ].join(" ")}
    >
      <tab.Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
      <span className="whitespace-nowrap">{tab.label}</span>
      {dirty ? (
        <span
          aria-label="Unsaved changes"
          className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-accent-cyan"
        />
      ) : null}
    </button>
  );
}
