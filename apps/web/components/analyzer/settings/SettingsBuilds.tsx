"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Plus, Trash2, ListTree } from "lucide-react";
import { apiCall, useApi, type ClientApiError } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";

type CustomBuild = {
  name: string;
  notes?: string;
  synonyms?: string[];
  updatedAt?: string;
};

type CustomBuildsResp = { items: CustomBuild[] };

export function SettingsBuilds() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApi<CustomBuildsResp>(
    "/v1/custom-builds",
  );
  const { toast } = useToast();

  const [draftName, setDraftName] = useState("");
  const [draftSyn, setDraftSyn] = useState("");
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function add() {
    const name = draftName.trim();
    if (adding || !name) return;
    setAdding(true);
    try {
      await apiCall(getToken, "/v1/custom-builds", {
        method: "POST",
        body: JSON.stringify({
          name,
          synonyms: draftSyn
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      setDraftName("");
      setDraftSyn("");
      await mutate();
      toast.success(`Added "${name}"`);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't add build", { description: message });
    } finally {
      setAdding(false);
    }
  }

  async function confirmRemove() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await apiCall(getToken, `/v1/custom-builds/${encodeURIComponent(pendingDelete)}`, {
        method: "DELETE",
      });
      await mutate();
      toast.success("Build removed");
      setPendingDelete(null);
    } catch (err) {
      const message =
        (err as ClientApiError | undefined)?.message ?? "Please try again.";
      toast.error("Couldn't delete build", { description: message });
    } finally {
      setDeleting(false);
    }
  }

  if (isLoading) return <Skeleton rows={3} />;
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <Section
        title="Add a custom build"
        description="Teach the analyzer your own opener naming so callouts and overlays match what you actually say."
      >
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2fr_auto]"
          >
            <Field label="Name" required>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g. Cannon Rush"
                autoComplete="off"
              />
            </Field>
            <Field label="Synonyms" hint="Comma-separated alternate names">
              <Input
                value={draftSyn}
                onChange={(e) => setDraftSyn(e.target.value)}
                placeholder="forge fast expand, FFE"
                autoComplete="off"
              />
            </Field>
            <div className="flex items-end">
              <Button
                type="submit"
                variant="primary"
                loading={adding}
                disabled={!draftName.trim()}
                fullWidth
                iconLeft={<Plus className="h-4 w-4" aria-hidden />}
              >
                Add build
              </Button>
            </div>
          </form>
        </Card>
      </Section>

      <Section
        title="Your custom builds"
        description="The analyzer matches replays against this list before falling back to the global catalog."
      >
        <Card padded={items.length === 0}>
          {items.length === 0 ? (
            <EmptyStatePanel
              icon={<ListTree className="h-6 w-6" aria-hidden />}
              title="No custom builds yet"
              description="Add the names you and your community actually use — the analyzer will pick them up across all your replays."
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((b) => (
                <li
                  key={b.name}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-body font-medium text-text">
                      {b.name}
                    </div>
                    {b.synonyms && b.synonyms.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {b.synonyms.map((s) => (
                          <Badge key={s} variant="neutral" size="sm">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete(b.name)}
                    iconLeft={<Trash2 className="h-4 w-4" aria-hidden />}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => (deleting ? undefined : setPendingDelete(null))}
        onConfirm={confirmRemove}
        title="Delete custom build?"
        description={
          pendingDelete
            ? `"${pendingDelete}" will no longer match in the analyzer or overlays. You can always re-add it.`
            : undefined
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        intent="danger"
        loading={deleting}
      />
    </div>
  );
}
