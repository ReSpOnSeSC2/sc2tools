"use client";
import { isAnalyticsConfigured, openCookieSettings } from "@/lib/analytics/consent";
export function CookieSettingsButton() {
  return isAnalyticsConfigured() ? <button type="button" onClick={openCookieSettings} className="inline-flex min-h-11 items-center rounded text-caption text-accent underline underline-offset-2 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Cookie settings</button> : null;
}
