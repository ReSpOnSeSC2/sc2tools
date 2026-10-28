"use client";

import { createContext, useContext, useLayoutEffect } from "react";
import type { SettingsTabId } from "@/lib/settingsRegistry";

export type CommandNavigation = {
  key: string; href: string; label: string; description?: string;
};
export type CommandChrome = {
  ownerKey: string | null; navigation: readonly CommandNavigation[];
  /** Normal Settings uses defaultTabVisibility; an admitted Shell overrides this. */
  defaultSettingsAvailable?: boolean;
};
export type CommandSettings = {
  ownerKey: string | null; tabs: readonly SettingsTabId[]; navigate: (href: string, admission?: CommandAdmission) => void;
};
/** The provider transfers a current selection before its dialog unmounts.
 * Settings checks this lease again after dirty confirmation and retires it on
 * Stay/commit. Ordinary Settings navigation has no command lease. */
export type CommandAdmission = (() => boolean) & { retire?: () => void };
export type CommandOpening = {
  scope?: "all" | "guides"; query?: string; defaultMatchup?: string; returnFocus?: HTMLElement | null;
};
export type CommandSearchContextValue = {
  ownerKey: string | null;
  open: (options?: CommandOpening) => void;
  registerChrome: (config: CommandChrome) => () => void;
  registerSettings: (config: CommandSettings) => () => void;
};
export const CommandSearchContext = createContext<CommandSearchContextValue | null>(null);
export function useCommandSearch() { return useContext(CommandSearchContext); }

/** Only committed chrome/Settings closures may admit a later palette selection. */
export function useCommandChrome(config: CommandChrome) {
  const context = useCommandSearch();
  useLayoutEffect(() => context?.registerChrome(config), [context, config]);
}
export function useCommandSettings(config: CommandSettings) {
  const context = useCommandSearch();
  useLayoutEffect(() => context?.registerSettings(config), [context, config]);
}
