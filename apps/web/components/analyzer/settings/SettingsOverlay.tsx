"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  Plus,
  Copy,
  Trash2,
  Tv,
  ChevronDown,
  ChevronRight,
  Check,
} from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { fmtAgo } from "@/lib/format";

type OverlayToken = {
  token: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  enabledWidgets?: string[];
};

type OverlayResp = { items: OverlayToken[] };

const WIDGETS: ReadonlyArray<string> = [
  "opponent",
  "match-result",
  "post-game",
  "mmr-delta",
  "streak",
  "cheese",
  "rematch",
  "rival",
  "rank",
  "meta",
  "topbuilds",
  "fav-opening",
  "best-answer",
  "scouting",
  "session",
];

export function SettingsOverlay({ origin }: { origin?: string }) {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<OverlayResp>(
    "/v1/overlay-tokens",
  );
  const { toast } = useToast();

  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<OverlayToken | null>(null);
  const [revoking, setRevoking] = useState(false);

  async function mint() {
    const trimmed = label.trim() || "Default";
    if (minting) return;
    setMinting(true);
    try {
      await apiCall(getToken, "/v1/overlay-tokens", {
        method: "POST",
        body: JSON.stringify({ label: trimmed }),
      });
      setLabel("");
      await mutate();
      toast.success(`Minted "${trimmed}" overlay token`);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't mint token", { description: message });
    } finally {
      setMinting(false);
    }
  }

  async function confirmRevoke() {
    const target = pendingRevoke;
    if (!target || revoking) return;
    setRevoking(true);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(target.token)}`,
        { method: "DELETE" },
      );
      await mutate();
      toast.success(`"${target.label}" revoked`);
      setPendingRevoke(null);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't revoke token", { description: message });
    } finally {
      setRevoking(false);
    }
  }

  async function toggleWidget(token: string, widget: string, on: boolean) {
    if (busyToken) return;
    setBusyToken(token);
    try {
      await apiCall(
        getToken,
        `/v1/overlay-tokens/${encodeURIComponent(token)}/widgets`,
        {
          method: "PATCH",
          body: JSON.stringify({ widget, enabled: on }),
        },
      );
      await mutate();
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't update widget", { description: message });
    } finally {
      setBusyToken(null);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = (data?.items ?? []).filter((i) => !i.revokedAt);

  return (
    <div className="space-y-6">
      <Section
        title="Mint a new overlay URL"
        description="Each token is a hidden bearer credential. Paste the resulting URL into OBS as a Browser Source."
      >
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mint();
            }}
            className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end"
          >
            <Field label="Label" hint="Helps you tell tokens apart later">
              <Input
                value={label}
                placeholder="main stream, friend test, …"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={minting}
              iconLeft={<Plus className="h-4 w-4" aria-hidden />}
            >
              Mint token
            </Button>
          </form>
        </Card>
      </Section>

      <Section
        title="Active overlay tokens"
        description="Each token grants access to the OBS Browser Source URL. Revoke immediately if a stream key leaks."
      >
        <Card padded={items.length === 0}>
          {items.length === 0 ? (
            <EmptyStatePanel
              icon={<Tv className="h-6 w-6" aria-hidden />}
              title="No active overlays"
              description="Mint a token above to generate your first overlay URL."
            />
          ) : (
            <ul className="space-y-3 p-4">
              {items.map((t) => (
                <OverlayTokenCard
                  key={t.token}
                  token={t}
                  origin={origin}
                  busy={busyToken === t.token}
                  onRequestRevoke={() => setPendingRevoke(t)}
                  onToggleWidget={(w, on) => toggleWidget(t.token, w, on)}
                />
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onClose={() => (revoking ? undefined : setPendingRevoke(null))}
        onConfirm={confirmRevoke}
        title="Revoke overlay token?"
        description={
          pendingRevoke
            ? `OBS sources using "${pendingRevoke.label}" will go blank immediately. This can't be undone — you'll need a new token + URL.`
            : undefined
        }
        confirmLabel="Revoke"
        cancelLabel="Cancel"
        intent="danger"
        loading={revoking}
      />
    </div>
  );
}

function OverlayTokenCard({
  token,
  origin,
  busy,
  onRequestRevoke,
  onToggleWidget,
}: {
  token: OverlayToken;
  origin?: string;
  busy: boolean;
  onRequestRevoke: () => void;
  onToggleWidget: (widget: string, enabled: boolean) => void;
}) {
  const url = `${origin ?? ""}/overlay/${token.token}`;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const enabled = new Set<string>(token.enabledWidgets ?? WIDGETS);

  const onCopy = async () => {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="rounded-lg border border-border bg-bg-elevated">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-medium text-text">
              {token.label}
            </span>
            <Badge variant="cyan" size="sm">
              {`${token.token.slice(0, 6)}…${token.token.slice(-4)}`}
            </Badge>
          </div>
          <div className="mt-0.5 text-caption text-text-muted">
            Created {fmtAgo(token.createdAt)}
            {token.lastSeenAt
              ? ` · seen ${fmtAgo(token.lastSeenAt)}`
              : " · not yet connected"}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onCopy}
            iconLeft={
              copied ? (
                <Check className="h-4 w-4" aria-hidden />
              ) : (
                <Copy className="h-4 w-4" aria-hidden />
              )
            }
          >
            {copied ? "Copied" : "Copy URL"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRequestRevoke}
            iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
          >
            Revoke
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-caption text-text-muted hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span>
          Configure widgets ({enabled.size} of {WIDGETS.length})
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
      </button>
      {open ? (
        <div className="grid grid-cols-1 gap-2 border-t border-border px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
          {WIDGETS.map((w) => (
            <label
              key={w}
              className="flex items-center justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 hover:border-border hover:bg-bg-surface"
            >
              <span className="text-caption text-text">{w}</span>
              <Toggle
                checked={enabled.has(w)}
                disabled={busy}
                onChange={(on) => onToggleWidget(w, on)}
                label={`Toggle ${w}`}
              />
            </label>
          ))}
        </div>
      ) : null}
    </li>
  );
}
