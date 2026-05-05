"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Folder as FolderIcon,
  FolderPlus,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

type FolderItem = {
  path: string;
  enabled: boolean;
  isCore?: boolean;
  lastScannedAt?: string | null;
};

type FoldersResp = {
  items: FolderItem[];
};

export function SettingsFolders() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<FoldersResp>(
    "/v1/import/cores",
  );
  const { toast } = useToast();
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function toggle(path: string, enabled: boolean) {
    if (busyPath) return;
    setBusyPath(path);
    const previous = data;
    try {
      const optimistic = previous
        ? {
            ...previous,
            items: previous.items.map((f) =>
              f.path === path ? { ...f, enabled } : f,
            ),
          }
        : previous;
      await mutate(optimistic, { revalidate: false });
      await apiCall(getToken, "/v1/import/cores", {
        method: "PATCH",
        body: JSON.stringify({ path, enabled }),
      });
      await mutate();
      toast.success(enabled ? "Folder enabled" : "Folder paused");
    } catch (err) {
      await mutate(previous, { revalidate: false });
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't update folder", { description: message });
    } finally {
      setBusyPath(null);
    }
  }

  async function pickFolder() {
    if (picking) return;
    setPicking(true);
    try {
      await apiCall(getToken, "/v1/import/pick-folder", {
        method: "POST",
        body: "{}",
      });
      await mutate();
      toast.success("Folder request sent to agent", {
        description:
          "If the agent is online it'll show a folder picker on the desktop.",
      });
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ??
        "Make sure the desktop agent is running.";
      toast.error("Couldn't reach the agent", { description: message });
    } finally {
      setPicking(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = data?.items ?? [];

  return (
    <Section
      title="Replay folders"
      description="The desktop agent watches these locations in real time. Disabling a folder pauses scanning without removing already-imported games."
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={pickFolder}
          loading={picking}
          iconLeft={<FolderPlus className="h-4 w-4" aria-hidden />}
        >
          Add folder
        </Button>
      }
    >
      <Card padded={items.length === 0}>
        {items.length === 0 ? (
          <EmptyStatePanel
            icon={<FolderIcon className="h-6 w-6" aria-hidden />}
            title="No folders configured"
            description="Add a replay folder to let the agent start ingesting games."
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={pickFolder}
                loading={picking}
                iconLeft={<FolderPlus className="h-4 w-4" aria-hidden />}
              >
                Browse for folder
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((f) => (
              <FolderRow
                key={f.path}
                folder={f}
                busy={busyPath === f.path}
                onToggle={(enabled) => toggle(f.path, enabled)}
              />
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function FolderRow({
  folder,
  busy,
  onToggle,
}: {
  folder: FolderItem;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const scanned = !!folder.lastScannedAt;
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <FolderIcon
        className="h-5 w-5 flex-shrink-0 text-accent-cyan"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-caption text-text">
          {folder.path}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {folder.isCore ? (
            <Badge
              variant="cyan"
              size="sm"
              iconLeft={<ShieldCheck className="h-3 w-3" aria-hidden />}
            >
              Core
            </Badge>
          ) : null}
          {scanned ? (
            <Badge variant="success" size="sm">
              Scanned · {new Date(folder.lastScannedAt!).toLocaleString()}
            </Badge>
          ) : (
            <Badge
              variant="warning"
              size="sm"
              iconLeft={<AlertCircle className="h-3 w-3" aria-hidden />}
            >
              Awaiting first scan
            </Badge>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2 sm:gap-3">
        <span className="text-caption text-text-muted" aria-hidden>
          {folder.enabled ? "Enabled" : "Paused"}
        </span>
        <Toggle
          checked={folder.enabled}
          onChange={onToggle}
          disabled={busy}
          label={`Toggle scanning for ${folder.path}`}
        />
      </div>
    </li>
  );
}
