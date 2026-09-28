"use client";

/**
 * `useFolderSync` — state and actions behind the Folder Sync card, shared
 * with the import panel's "Sync a replay folder" button (the folder picker
 * must open synchronously inside that click).
 *
 *   Chrome / Edge: the picked folder's read-only handle is remembered on
 *   this device FOR THE SIGNED-IN ACCOUNT. When the remembered state
 *   belongs to another account (a shared browser) nothing syncs until
 *   this account clicks "Use this folder for this account", which forgets
 *   the other account's ledger first.
 *   Firefox / Safari: a one-off `<input webkitdirectory>` import through
 *   the same runner; the ledger (bound to the account the same way) still
 *   skips replays already done, and "Forget import history" clears it.
 *
 * Example:
 *   const folder = useFolderSync();
 *   <Button onClick={folder.pickFolder}>Choose your StarCraft II folder</Button>
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { API_BASE, apiCall } from "@/lib/clientApi";
import { trackInstantError, trackInstantFolderSyncResume } from "@/lib/instant/analytics";
import { createEngineClient } from "@/lib/instant/engineClient";
import { EngineError } from "@/lib/instant/engineErrors";
import { INSTANT_ENGINE_VERSION } from "@/lib/instant/engineVersion";
import { errorCopy } from "@/lib/instant/errorCopy";
import {
  filesFromDirectoryInput,
  isPermissionDenied,
  pickReplaysFolder,
  queryReadPermission,
  requestReadPermission,
  supportsDirectoryPicker,
  type DirectoryHandleLike,
  type ReadPermission,
} from "@/lib/instant/folderSync";
import {
  fetchProfileToons,
  folderLedgerCounts,
  runFolderSyncExclusive,
  type FolderSyncProgress,
  type FolderSyncSource,
  type FolderSyncSummary,
} from "@/lib/instant/folderSyncRunner";
import type { TokenGetter } from "@/lib/instant/httpRetry";
import {
  claimFolderSync,
  clearFolderHandle,
  clearLedger,
  getFolderOwner,
  getLastFolderScanAt,
  loadFolderHandle,
  saveFolderHandle,
} from "@/lib/instant/localStore";

interface FolderSyncState {
  /** null until mounted: browser support is only known client-side. */
  mode: "picker" | "input" | null;
  loaded: boolean;
  handle: DirectoryHandleLike | null;
  /** The account the remembered Folder Sync state belongs to. */
  owner: string | null;
  permission: ReadPermission | null;
  lastScanAt: number | null;
  syncedCount: number | null;
  /** Every remembered file (uploads, skips and failures). */
  historyCount: number | null;
  running: boolean;
  progress: FolderSyncProgress | null;
  lastRun: FolderSyncSummary | null;
  error: string | null;
  /** False when IndexedDB is blocked (private window): nothing is remembered. */
  storageAvailable: boolean;
}

export interface FolderSyncController extends Omit<FolderSyncState, "handle" | "owner"> {
  folderName: string | null;
  /** A folder is remembered, but for another account (or no account). */
  ownerMismatch: boolean;
  /** Opens the folder picker; call directly from a click handler. */
  pickFolder(): void;
  /** Re-grants read access (click handler) and syncs. */
  resume(): void;
  syncNow(): void;
  /** Bind the remembered folder to this account (another account's ledger is forgotten). */
  claimForThisAccount(): void;
  /** One-off import of an `<input webkitdirectory>` selection. */
  importFiles(files: ReadonlyArray<File>): void;
  /** Forget the folder and its ledger ("Stop syncing" / "Forget import history"). */
  stop(): Promise<void>;
  cancel(): void;
}

const INITIAL: FolderSyncState = {
  mode: null, loaded: false, handle: null, owner: null, permission: null, lastScanAt: null, syncedCount: null,
  historyCount: null, running: false, progress: null, lastRun: null, error: null, storageAvailable: true,
};

const ALREADY_RUNNING = "Folder Sync is already running in another SC2 Tools tab.";
const UNEXPECTED = "Folder Sync stopped unexpectedly. Try again.";
/** Shown when a folder without ladder replays was picked or imported. */
export const NO_REPLAYS =
  "No ladder replays found in that folder. Choose your StarCraft II Accounts folder (or a player folder inside it).";
const PICKER_FAILED = "Your browser didn't open the folder picker. Try again, or drag the folder onto the import area.";
const ACCESS_DENIED = "Access to that folder was blocked. Choose it again and allow read access to keep syncing.";
const NOT_OWNER = "Folder Sync in this browser belongs to another account. Use this folder for this account to sync it.";

function syncErrorText(error: unknown): string {
  if (!(error instanceof EngineError)) return UNEXPECTED;
  const copy = errorCopy(error.kind);
  return `${copy.title}. ${copy.hint}`;
}

async function ledgerPatch(): Promise<Partial<FolderSyncState>> {
  const counts = await folderLedgerCounts();
  return { syncedCount: counts.synced, historyCount: counts.total };
}

async function loadStoredState(): Promise<Partial<FolderSyncState>> {
  try {
    const handle = await loadFolderHandle();
    const permission = handle ? await queryReadPermission(handle) : null;
    const owner = await getFolderOwner();
    return { handle, owner, permission, lastScanAt: await getLastFolderScanAt(), ...(await ledgerPatch()) };
  } catch {
    trackInstantError({ kind: "storage_unavailable" });
    return { storageAvailable: false };
  }
}

function trackDenied(): void {
  trackInstantError({ kind: "folder_permission_denied" });
}

type Patch = (next: Partial<FolderSyncState>) => void;
type StateRef = { readonly current: FolderSyncState };

interface PassContext {
  getToken: TokenGetter;
  userId: string;
  signal: AbortSignal;
  patch: Patch;
  stateRef: StateRef;
}

function afterPass(summary: FolderSyncSummary | null, ctx: PassContext): Partial<FolderSyncState> {
  if (summary === null) return { error: ALREADY_RUNNING };
  if (summary.notOwner) return { error: NOT_OWNER, owner: null };
  return { lastRun: summary, lastScanAt: summary.aborted ? ctx.stateRef.current.lastScanAt : Date.now() };
}

/** One pass; resolves once its result (or error) is in state. */
async function runOnePass(source: FolderSyncSource, ctx: PassContext): Promise<void> {
  const { getToken, patch, stateRef } = ctx;
  try {
    const summary = await runFolderSyncExclusive({
      source, engineFactory: () => createEngineClient(), getToken, apiBase: API_BASE,
      engineVersion: INSTANT_ENGINE_VERSION, profileToons: () => fetchProfileToons(getToken, apiCall),
      ownerUserId: ctx.userId, now: Date.now, signal: ctx.signal, onProgress: (progress) => patch({ progress }),
    });
    patch(afterPass(summary, ctx));
    const { syncedCount, historyCount } = stateRef.current;
    patch(await ledgerPatch().catch(() => ({ syncedCount, historyCount })));
  } catch (error) {
    if (error instanceof EngineError) trackInstantError({ kind: error.kind });
    patch({ error: syncErrorText(error) });
  }
}

/** The sync pass itself: one at a time, cancellable, result kept in state. */
function useSyncRunner(patch: Patch, stateRef: StateRef, userId: string | null) {
  const { getToken } = useAuth();
  const abortRef = useRef<AbortController | null>(null);
  const passRef = useRef<Promise<void> | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const sync = useCallback(
    (source: FolderSyncSource): Promise<void> => {
      if (passRef.current) return passRef.current;
      if (!userId) return Promise.resolve(); // Folder Sync always belongs to a signed-in account
      const controller = new AbortController();
      abortRef.current = controller;
      patch({ running: true, progress: null, error: null });
      const pass = runOnePass(source, { getToken, userId, signal: controller.signal, patch, stateRef }).finally(() => {
        passRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
        patch({ running: false, progress: null });
      });
      passRef.current = pass;
      return pass;
    },
    [getToken, patch, stateRef, userId],
  );
  const cancel = useCallback(() => abortRef.current?.abort(), []);
  /** Cancels the running pass (if any) and resolves once it has wound down. */
  const cancelAndWait = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    await passRef.current;
  }, []);
  return { sync, cancel, cancelAndWait };
}

type Runner = ReturnType<typeof useSyncRunner>;

/** Bind the Folder Sync state to `userId`; a different owner's history is gone afterwards. */
async function bindTo(userId: string, patch: Patch, stateRef: StateRef): Promise<void> {
  if (stateRef.current.owner === userId) return;
  await claimFolderSync(userId).catch(() => undefined); // storage blocked: nothing remembered to protect
  patch({ owner: userId, syncedCount: 0, historyCount: 0, lastRun: null, lastScanAt: null, error: null });
}

/** Picker actions: they open the picker or a permission prompt inside the click. */
function usePickerActions(patch: Patch, stateRef: StateRef, runner: Runner, userId: string | null) {
  const { sync } = runner;
  const pickFolder = useCallback(() => {
    if (!userId) return;
    // pickReplaysFolder opens the picker synchronously, inside the click.
    void pickReplaysFolder()
      .then(async (handle) => {
        if (!handle) return;
        await saveFolderHandle(handle, userId).catch(() => patch({ storageAvailable: false }));
        if (stateRef.current.owner !== userId) patch({ syncedCount: 0, historyCount: 0, lastRun: null, lastScanAt: null });
        patch({ handle, owner: userId, permission: "granted" });
        await sync({ handle });
      })
      .catch((error: unknown) => {
        if (isPermissionDenied(error)) trackDenied();
        patch({ error: isPermissionDenied(error) ? ACCESS_DENIED : PICKER_FAILED });
      });
  }, [patch, stateRef, sync, userId]);
  const resume = useCallback(() => {
    const handle = stateRef.current.handle;
    if (!handle) return;
    void requestReadPermission(handle).then(async (permission) => {
      patch({ permission });
      if (permission === "denied") trackDenied();
      if (permission !== "granted") return;
      trackInstantFolderSyncResume();
      await sync({ handle });
    });
  }, [patch, stateRef, sync]);
  const syncNow = useCallback(() => {
    const { handle, permission } = stateRef.current;
    if (handle && permission === "granted") void sync({ handle });
    else resume();
  }, [resume, stateRef, sync]);
  const claimForThisAccount = useCallback(() => {
    if (userId) void bindTo(userId, patch, stateRef);
  }, [patch, stateRef, userId]);
  return { pickFolder, resume, syncNow, claimForThisAccount };
}

/** Folder-input import (Firefox/Safari) and forgetting everything. */
function useImportActions(patch: Patch, stateRef: StateRef, runner: Runner, userId: string | null) {
  const { sync, cancel, cancelAndWait } = runner;
  const importFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      const replays = filesFromDirectoryInput(files);
      if (replays.length === 0) patch({ error: NO_REPLAYS });
      else if (userId) void bindTo(userId, patch, stateRef).then(() => sync({ files: replays }));
    },
    [patch, stateRef, sync, userId],
  );
  const stop = useCallback(async () => {
    // Let a running pass wind down first, so none of its results land
    // after the folder and its ledger are forgotten.
    await cancelAndWait();
    await Promise.all([clearFolderHandle(), clearLedger()]).catch(() => undefined);
    patch({ handle: null, owner: null, permission: null, syncedCount: 0, historyCount: 0, lastRun: null, error: null });
  }, [cancelAndWait, patch]);
  return { importFiles, stop, cancel };
}

/**
 * State + actions for Folder Sync (see module comment).
 *
 * Example:
 *   const folder = useFolderSync();
 *   <Button onClick={folder.pickFolder}>Choose your StarCraft II folder</Button>
 */
export function useFolderSync(): FolderSyncController {
  const { userId } = useAuth();
  const [state, setState] = useState<FolderSyncState>(INITIAL);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const patch = useCallback<Patch>((next) => setState((prev) => ({ ...prev, ...next })), []);
  useEffect(() => {
    let alive = true;
    const mode = supportsDirectoryPicker() ? "picker" : "input";
    void loadStoredState().then((stored) => {
      if (alive) patch({ ...stored, mode, loaded: true });
    });
    return () => {
      alive = false;
    };
  }, [patch]);
  const account = userId ?? null;
  const runner = useSyncRunner(patch, stateRef, account);
  const pickerActions = usePickerActions(patch, stateRef, runner, account);
  const importActions = useImportActions(patch, stateRef, runner, account);
  const { handle, owner, ...rest } = state;
  const ownerMismatch = handle !== null && state.storageAvailable && owner !== account;
  return { ...rest, folderName: handle?.name ?? null, ownerMismatch, ...pickerActions, ...importActions };
}
