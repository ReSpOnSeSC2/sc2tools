import { OVERLAY_CREDIT_STORAGE_KEY } from "./overlayCredit";
import { GHOST_VOICE_STORAGE_KEY } from "./ghostVoice";
import type { OverlayProfileFlags } from "./overlayProfile";

/**
 * One-time move of the older per-browser overlay choices (the credit
 * switch and Ghost voice) into the account's overlay profile.
 *
 * The browser values are read only while the profile has no value for
 * that flag, and only until this token's migration is marked done, so a
 * stale browser can never overwrite a choice made on another device.
 *
 * Example:
 *   legacyOverlayFlags({}, localStorage) // -> { credit: false } when the old switch was off
 */

const MIGRATION_PREFIX = "sc2tools:overlay-flags-migrated";

/** Per owner and token: every token used the same browser-wide choice. */
export function overlayFlagsMigrationKey(ownerId: string, token: string): string {
  return `${MIGRATION_PREFIX}:${ownerId}:${token}`;
}

type StorageReader = Pick<Storage, "getItem">;

function readBoolean(storage: StorageReader, key: string, on: string, off: string): boolean | undefined {
  try {
    const raw = storage.getItem(key);
    return raw === on ? true : raw === off ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Browser values for the flags the profile has not chosen yet. */
export function legacyOverlayFlags(profile: OverlayProfileFlags, storage: StorageReader | null): OverlayProfileFlags {
  if (!storage) return {};
  const flags: OverlayProfileFlags = {};
  if (profile.credit === undefined) {
    const credit = readBoolean(storage, OVERLAY_CREDIT_STORAGE_KEY, "1", "0");
    if (credit !== undefined) flags.credit = credit;
  }
  if (profile.ghostVoice === undefined) {
    const ghostVoice = readBoolean(storage, GHOST_VOICE_STORAGE_KEY, "1", "0");
    if (ghostVoice !== undefined) flags.ghostVoice = ghostVoice;
  }
  return flags;
}
