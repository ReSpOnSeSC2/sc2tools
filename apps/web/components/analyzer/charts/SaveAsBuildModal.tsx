"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { CheckCircle2 } from "lucide-react";
import { apiCall } from "@/lib/clientApi";
import { eventsToSignature, slugifyBuildName } from "@/lib/build-events";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import type {
  BuildEventRow,
  BuildPerspective,
  Race,
  SaveAsBuildPayload,
  VsRace,
} from "./BuildOrderTimeline.types";

/**
 * SaveAsBuildModal — captures a name for a snapshot of build events
 * and persists them to /v1/custom-builds/:slug.
 *
 * Behaviour:
 *   - Submit-on-Enter validates name + signature, then PUTs the build.
 *   - On success: shows a brief inline confirmation, fires onSaved
 *     (so parents on a surface with ToastProvider can fire a toast),
 *     then closes after 700ms.
 *   - On failure: surfaces the error inline and keeps the modal open
 *     so the user can retry without losing the typed name.
 *
 * Race / vs-race default to whatever was active at open time but the
 * user can override before saving.
 */
export interface SaveAsBuildModalProps {
  open: boolean;
  onClose: () => void;
  rows: BuildEventRow[];
  defaultName?: string;
  perspective: BuildPerspective;
  race: Race;
  vsRace: VsRace;
  gameId?: string;
  /** Notified after a successful save. The modal closes automatically. */
  onSaved?: (payload: SaveAsBuildPayload & { slug: string }) => void;
  /**
   * Custom save handler. When provided, the modal calls this instead
   * of the built-in /v1/custom-builds/:slug PUT. Throw to surface an
   * inline error and keep the modal open.
   */
  onCustomSave?: (
    payload: SaveAsBuildPayload & { slug: string },
  ) => Promise<void> | void;
}

const RACES: Race[] = ["Protoss", "Terran", "Zerg", "Random"];
const VS_RACES: VsRace[] = ["Protoss", "Terran", "Zerg", "Random", "Any"];

function describePerspective(perspective: BuildPerspective): string {
  return perspective === "opponent" ? "opponent" : "your";
}

function suggestName(
  defaultName: string | undefined,
  race: Race,
  vsRace: VsRace,
  perspective: BuildPerspective,
): string {
  if (defaultName && defaultName.trim()) return defaultName.trim();
  const matchup = vsRace === "Any" ? "Any" : vsRace;
  const owner = perspective === "opponent" ? "Opp" : "My";
  return `${owner} ${race} vs ${matchup}`;
}

export function SaveAsBuildModal({
  open,
  onClose,
  rows,
  defaultName,
  perspective,
  race,
  vsRace,
  gameId,
  onSaved,
  onCustomSave,
}: SaveAsBuildModalProps) {
  const { getToken } = useAuth();
  const [name, setName] = useState("");
  const [raceValue, setRaceValue] = useState<Race>(race);
  const [vsRaceValue, setVsRaceValue] = useState<VsRace>(vsRace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  // Reset form whenever the modal opens with a new context.
  useEffect(() => {
    if (!open) return;
    setName(suggestName(defaultName, race, vsRace, perspective));
    setRaceValue(race);
    setVsRaceValue(vsRace);
    setError(null);
    setSavedOk(false);
    setSaving(false);
  }, [open, defaultName, race, vsRace, perspective]);

  const signaturePreview = useMemo(() => eventsToSignature(rows), [rows]);
  const stepCount = signaturePreview.length;
  const trimmedName = name.trim();
  const canSubmit =
    !saving && !savedOk && trimmedName.length > 0 && stepCount > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    const slug = slugifyBuildName(trimmedName);
    if (!slug) {
      setSaving(false);
      setError("Pick a name with at least one letter or number.");
      return;
    }
    const payload: SaveAsBuildPayload & { slug: string } = {
      name: trimmedName,
      race: raceValue,
      vsRace: vsRaceValue,
      rows,
      gameId,
      perspective,
      slug,
    };
    try {
      if (onCustomSave) {
        await onCustomSave(payload);
      } else {
        await apiCall<void>(
          getToken,
          `/v1/custom-builds/${encodeURIComponent(slug)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              name: trimmedName,
              race: raceValue,
              vsRace: vsRaceValue,
              signature: signaturePreview,
              description: gameId
                ? `Captured from game ${gameId} (${describePerspective(perspective)} build).`
                : `Captured ${describePerspective(perspective)} build.`,
              perspective,
              sourceGameId: gameId,
              // When saving from the opponent's perspective, the user's
              // selected vsRace IS the opponent's race — but we record
              // it explicitly so the builds page can surface a "from
              // opponent" badge with the actual race played.
              opponentRace:
                perspective === "opponent" ? raceValue : undefined,
            }),
          },
        );
      }
      setSaving(false);
      setSavedOk(true);
      onSaved?.(payload);
      window.setTimeout(() => onClose(), 700);
    } catch (err: unknown) {
      setSaving(false);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "object" && err && "message" in err
            ? String((err as { message: unknown }).message)
            : "Save failed.";
      setError(message);
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? () => undefined : onClose}
      title={`Save as new build`}
      description={
        stepCount > 0
          ? `Captures ${stepCount} ${describePerspective(perspective)}-build steps as a custom build matchable across your library.`
          : `No mappable build events on this game yet.`
      }
      size="lg"
      disableScrimClose={saving}
      hideClose={saving}
      footer={
        <ModalActions>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={saving}
          >
            {savedOk ? "Saved" : "Save build"}
          </Button>
        </ModalActions>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="space-y-4"
      >
        <Field label="Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Glaive Adept Timing"
            autoFocus
            maxLength={120}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Race">
            <Select
              value={raceValue}
              onChange={(e) => setRaceValue(e.target.value as Race)}
            >
              {RACES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Versus race">
            <Select
              value={vsRaceValue}
              onChange={(e) => setVsRaceValue(e.target.value as VsRace)}
            >
              {VS_RACES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2.5 text-caption text-text-muted">
          <span className="font-semibold text-text">{stepCount}</span> mappable
          step{stepCount === 1 ? "" : "s"} from the {describePerspective(perspective)} build
          will be saved as the build signature.
        </div>
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-caption text-danger"
          >
            {error}
          </div>
        ) : null}
        {savedOk ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-caption text-success"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Saved. You can find it under My Builds.
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
