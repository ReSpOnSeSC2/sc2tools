import { API_BASE } from "@/lib/apiBase";
import { readBalanceBundle, type BalanceBundle } from "./bundle";

export async function loadBalanceBundle(signal?: AbortSignal): Promise<BalanceBundle> {
  const deadline = AbortSignal.timeout(10_000);
  const response = await fetch(`${API_BASE}/v1/ladder/balance`, {
    credentials: "omit",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw new Error("The ladder balance snapshot is unavailable.");
  const bundle = readBalanceBundle(await response.json());
  if (!bundle) throw new Error("The ladder balance snapshot could not be read.");
  return bundle;
}
