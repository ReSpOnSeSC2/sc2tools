"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { FileUp } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import {
  IMPORT_BATCH_SIZE,
  IMPORT_MAX_BYTES,
  LIBRARY_MAX_BUILDS,
  importBuildBatch,
  parseImportSource,
  type ConflictChoice,
  type ImportCandidate,
  type ImportResult,
} from "@/lib/buildLibrary";

interface Row extends ImportCandidate {
  status: "new" | "conflict" | "invalid";
  onConflict: ConflictChoice;
}

const CHOICES: ReadonlyArray<{ value: ConflictChoice; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "copy", label: "Save a copy" },
  { value: "overwrite", label: "Overwrite" },
];

function message(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "library_full") {
    return `Your library can hold ${LIBRARY_MAX_BUILDS} builds. Delete some, or import fewer.`;
  }
  return err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : fallback;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < list.length; start += size) out.push(list.slice(start, start + size));
  return out;
}

/**
 * Import builds from a .json file (an export), pasted JSON or a share
 * code. Everything is validated here first; the preview then asks the
 * server which builds are new, which clash with one you already have
 * (skip, save a copy, or overwrite — the replaced version stays in its
 * History) and which are invalid. Imports run in batches of 100 with one
 * replay matching run at the end.
 */
export function ImportBuildsDialog({
  open,
  initialSource = "",
  onClose,
  onImported,
}: {
  open: boolean;
  initialSource?: string;
  onClose: () => void;
  onImported: (summary: string) => void;
}) {
  const { getToken } = useAuth();
  const [source, setSource] = useState(initialSource);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceId = useId();

  useEffect(() => {
    if (!open) return;
    setSource(initialSource);
    setRows(null);
    setError(null);
  }, [open, initialSource]);

  const preview = async (text = source) => {
    setError(null);
    setRows(null);
    const parsed = parseImportSource(text);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const valid = parsed.candidates.filter((candidate) => candidate.build);
    setBusy("preview");
    try {
      const statuses = new Map<number, ImportResult>();
      for (const batch of chunks(valid, IMPORT_BATCH_SIZE)) {
        const res = await importBuildBatch(getToken, batch.map((candidate) => ({ build: candidate.build! })), { dryRun: true });
        for (const result of res.results) statuses.set(batch[result.index].index, result);
      }
      setRows(parsed.candidates.map((candidate) => {
        const server = statuses.get(candidate.index);
        const status = !candidate.build || server?.status === "invalid" ? "invalid" : server?.status === "conflict" ? "conflict" : "new";
        return { ...candidate, errors: candidate.errors ?? server?.errors, status, onConflict: "skip" };
      }));
    } catch (err) {
      setError(message(err, "The preview couldn't load. Try again."));
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      setError("That file is too large to import (2 MB at most).");
      return;
    }
    const text = await file.text();
    setSource(text);
    await preview(text);
  };

  const runImport = async () => {
    if (!rows) return;
    const todo = rows.filter((row) => row.build && row.status !== "invalid" && !(row.status === "conflict" && row.onConflict === "skip"));
    if (todo.length === 0) return;
    setBusy("import");
    setError(null);
    const counts: Record<string, number> = {};
    try {
      const batches = chunks(todo, IMPORT_BATCH_SIZE);
      for (const [index, batch] of batches.entries()) {
        const res = await importBuildBatch(
          getToken,
          batch.map((row) => ({ build: row.build!, onConflict: row.onConflict })),
          { reclassify: index === batches.length - 1 },
        );
        for (const result of res.results) counts[result.status] = (counts[result.status] ?? 0) + 1;
      }
      const made = (counts.created ?? 0) + (counts.copied ?? 0) + (counts.overwritten ?? 0);
      const extras = [
        counts.copied ? `${counts.copied} saved as copies` : "",
        counts.overwritten ? `${counts.overwritten} overwritten` : "",
        counts.failed || counts.invalid ? `${(counts.failed ?? 0) + (counts.invalid ?? 0)} failed` : "",
      ].filter(Boolean).join(", ");
      onImported(`Imported ${made} build${made === 1 ? "" : "s"}${extras ? ` (${extras})` : ""}.`);
      onClose();
    } catch (err) {
      setError(message(err, "The import stopped. Builds imported so far are in your library."));
    } finally {
      setBusy(null);
    }
  };

  const importable = rows?.filter((row) => row.status === "new" || (row.status === "conflict" && row.onConflict !== "skip")).length ?? 0;

  return (
    <Modal
      open={open}
      onClose={busy === "import" ? () => undefined : onClose}
      title="Import builds"
      description="From an exported .json file, pasted JSON or a share code."
      size="lg"
      disableScrimClose={busy === "import"}
      footer={rows ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setRows(null)} disabled={busy !== null}>Back</Button>
          <Button onClick={() => void runImport()} loading={busy === "import"} disabled={importable === 0}>
            {importable === 0 ? "Nothing to import" : `Import ${importable} build${importable === 1 ? "" : "s"}`}
          </Button>
        </div>
      ) : undefined}
    >
      {rows ? (
        <ImportPreview rows={rows} onChoose={(index, choice) => setRows((current) => current?.map((row) => (row.index === index ? { ...row, onConflict: choice } : row)) ?? null)} />
      ) : (
        <div className="space-y-3">
          <div>
            <label htmlFor={sourceId} className="mb-1 block text-caption font-semibold text-text">Share code or JSON</label>
            <textarea
              id={sourceId}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              rows={6}
              spellCheck={false}
              className="w-full rounded-lg border-2 border-line bg-bg-elevated p-3 font-mono text-caption text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void preview()} loading={busy === "preview"} disabled={!source.trim()}>Preview</Button>
            <input ref={fileRef} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => void readFile(event.target.files?.[0])} />
            <Button variant="secondary" iconLeft={<FileUp className="h-4 w-4" aria-hidden />} onClick={() => fileRef.current?.click()} disabled={busy !== null}>
              Choose a .json file
            </Button>
          </div>
        </div>
      )}
      {error ? <p role="alert" className="mt-3 text-caption text-danger">{error}</p> : null}
    </Modal>
  );
}

function ImportPreview({ rows, onChoose }: { rows: Row[]; onChoose: (index: number, choice: ConflictChoice) => void }) {
  const count = (status: Row["status"]) => rows.filter((row) => row.status === status).length;
  return (
    <div className="space-y-3">
      <p className="text-caption text-text-muted" role="status">
        {count("new")} new · {count("conflict")} already in your library · {count("invalid")} invalid
      </p>
      <ul className="max-h-[50vh] space-y-2 overflow-y-auto" aria-label="Builds to import">
        {rows.map((row) => (
          <li key={row.index} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2">
            <div className="min-w-0">
              <p className="break-words font-semibold text-text">{row.label}</p>
              {row.status === "invalid" && row.errors?.length ? <p className="text-micro text-danger">{row.errors.join(" ")}</p> : null}
            </div>
            {row.status === "conflict" ? (
              <Select
                aria-label={`When “${row.label}” is already in your library`}
                value={row.onConflict}
                onChange={(event) => onChoose(row.index, event.target.value as ConflictChoice)}
                className="w-40"
              >
                {CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </Select>
            ) : (
              <Badge size="sm" variant={row.status === "new" ? "success" : "danger"}>{row.status === "new" ? "New" : "Invalid"}</Badge>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
