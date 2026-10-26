"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type ComponentProps } from "react";
import { resolveSettingsDestination, type SettingsOverlayPane } from "@/lib/settingsRegistry";
import { SETTINGS_SECTIONS } from "@/lib/settingsIndex";
import { SettingsSectionNav } from "./SettingsSectionNav";

export const OVERLAY_SECTIONS = SETTINGS_SECTIONS.overlay;
export type OverlaySection = SettingsOverlayPane;
/** Compatibility hint only; sections are no longer hidden panes. */
export function useOverlaySection(): OverlaySection {
  const query = useSearchParams();
  const [hash, setHash] = useState("");
  useEffect(() => { const update = () => setHash(location.hash); update(); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); }, []);
  return resolveSettingsDestination(query.toString(), hash, "overlay").overlayPane;
}
export function OverlayManagerNav(props: Omit<ComponentProps<typeof SettingsSectionNav>, "tab" | "sections">) {
  return <SettingsSectionNav {...props} tab="overlay" sections={OVERLAY_SECTIONS} />;
}
