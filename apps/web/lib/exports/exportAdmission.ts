import { ExportDownloadError } from "./exportErrors";

type Listener = () => void;
let active: object | null = null;
const listeners = new Set<Listener>();
const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* One view cannot strand admission. */ } } };

export const exportBusy = () => active !== null;
export const exportBusyOnServer = () => false;
export function subscribeExportBusy(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Cancellation does not release this slot until actual adapter work settles. */
export async function withExportAdmission<T>(operation: () => Promise<T>): Promise<T> {
  if (active) throw new ExportDownloadError("busy");
  const lease = {};
  active = lease; notify();
  try { return await operation(); }
  finally { if (active === lease) { active = null; notify(); } }
}
