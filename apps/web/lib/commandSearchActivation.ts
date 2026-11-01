import type { CommandSearchItem } from "./commandSearch";
import type { CommandChrome } from "@/components/chrome/CommandSearchContext";
import { isCommandSearchHref } from "./commandSearchTarget";

const LIBRARIES: Readonly<Record<string, string>> = {
  "library:opponents": "/app/opponents", "library:customBuilds": "/builds", "library:maps": "/app/maps",
  "library:games": "/app/replays",
};
const PRIVATE_FIELDS: Readonly<Record<string, readonly [field: string, maximum: number, route: string]>> = {
  opponent: ["pulseId", 64, "/app/opponents/"], customBuild: ["slug", 120, "/builds/"],
  map: ["map", 200, "/app/maps?focus="], game: ["gameId", 200, "/app/game/"],
};

/** Pure strict constructor loaded by the fixed Runtime import. A response can
 * never supply its own href; this module stores no owner or result state. */
export function commandPrivateHref(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  if (!kind || !Object.hasOwn(kind, "value")) return null;
  if (typeof kind.value !== "string" || !Object.hasOwn(PRIVATE_FIELDS, kind.value)) return null;
  const [field, maximum, route] = PRIVATE_FIELDS[kind.value];
  const keys = Reflect.ownKeys(value), entry = Object.getOwnPropertyDescriptor(value, field);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes(field) || !entry?.enumerable
    || !kind.enumerable || !Object.hasOwn(entry, "value")) return null;
  const text: unknown = entry.value;
  if (typeof text !== "string" || !text.length || text.length > maximum || /[\p{Cc}\uD800-\uDFFF]/u.test(text)
    || (field !== "map" && (text === "." || text === ".."))) return null;
  return route + encodeURIComponent(text);
}

function admitsItem(item: CommandSearchItem, chrome: CommandChrome | null, ownerKey: string | null): boolean {
  if (item.disabled || (item.href && !isCommandSearchHref(item.href))) return false;
  if (item.id.startsWith("library:")) return !!ownerKey && Object.hasOwn(LIBRARIES, item.id) && item.href === LIBRARIES[item.id];
  if (item.group === "navigation" || item.group === "recent") {
    return chrome?.ownerKey === ownerKey && chrome.navigation.some(row =>
      row.href === item.href && (item.id === `navigation:${row.key}` || item.id === `recent:${row.key}`));
  }
  if ((item.group === "settings" || item.action === "pair-device") && !ownerKey) return false;
  return Boolean(item.href || item.action);
}

/** Trusted compiled code only. The Provider receives this from its own fixed
 * Runtime import; callers and server responses cannot register a policy. */
export const commandActivationPolicy = Object.freeze({ privateHref: commandPrivateHref, admitsItem });
export type CommandActivationPolicy = typeof commandActivationPolicy;
