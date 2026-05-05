/**
 * Clerk appearance theming for the SignIn / SignUp widgets.
 *
 * Clerk's `appearance.variables` field accepts color strings (hex/rgb)
 * but does NOT resolve CSS variable references at runtime, so the
 * palette below mirrors the tokens defined in app/globals.css. Keep
 * the two in sync — when a token changes there, change it here too.
 *
 * `appearance.elements` accepts Tailwind class strings, which DO flow
 * through CSS variables, so element styling is shared across themes.
 *
 * Pages call `appearanceFor(theme)` and pass the returned object to
 * `<SignIn>` / `<SignUp>`. Re-keying the widget on theme change forces
 * Clerk to re-render with the new appearance (Clerk caches internally
 * so a simple prop change isn't always enough).
 */
import type { Appearance } from "@clerk/types";
import type { Theme } from "@/lib/theme";

const DARK_VARS = {
  colorPrimary: "#7c8cff",
  colorBackground: "#11141b",
  colorInputBackground: "#161a23",
  colorInputText: "#e6e8ee",
  colorText: "#e6e8ee",
  colorTextSecondary: "#9aa3b2",
  colorTextOnPrimaryBackground: "#ffffff",
  colorDanger: "#ff6b6b",
  colorSuccess: "#3ec07a",
  colorWarning: "#e6b450",
  colorNeutral: "#9aa3b2",
} as const;

const LIGHT_VARS = {
  colorPrimary: "#5b6dff",
  colorBackground: "#ffffff",
  colorInputBackground: "#fafbff",
  colorInputText: "#0e1118",
  colorText: "#0e1118",
  colorTextSecondary: "#5a6378",
  colorTextOnPrimaryBackground: "#ffffff",
  colorDanger: "#d6494e",
  colorSuccess: "#22a35a",
  colorWarning: "#b78224",
  colorNeutral: "#5a6378",
} as const;

const SHARED_VARS = {
  borderRadius: "0.5rem",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  fontSize: "15px",
  fontWeight: { normal: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

/**
 * Element classes are token-driven via Tailwind utilities, so the same
 * class strings render correctly under both `data-theme="dark"` and
 * `data-theme="light"` thanks to the CSS-variable backed color tokens.
 */
const SHARED_ELEMENTS: Appearance["elements"] = {
  rootBox: "w-full",
  card:
    "bg-bg-surface border border-accent-cyan/25 shadow-halo-cyan rounded-xl",
  headerTitle: "text-text font-semibold",
  headerSubtitle: "text-text-muted",
  formButtonPrimary: [
    "bg-accent hover:bg-accent-hover active:translate-y-px",
    "text-white font-semibold rounded-lg h-11 min-w-[44px]",
    "transition-colors transition-transform duration-100",
    FOCUS_RING,
  ].join(" "),
  formFieldLabel: "text-text font-medium",
  formFieldInput: [
    "bg-bg-elevated text-text border border-border placeholder:text-text-dim",
    "h-11 px-3 rounded-lg",
    "focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/40",
  ].join(" "),
  formFieldInputShowPasswordButton: "text-text-muted hover:text-text",
  formFieldHintText: "text-text-muted",
  formFieldErrorText: "text-danger",
  identityPreviewText: "text-text",
  identityPreviewEditButton: "text-accent hover:text-accent-hover",
  footer: "text-text-muted",
  footerActionText: "text-text-muted",
  footerActionLink: "text-accent hover:text-accent-hover font-medium",
  dividerLine: "bg-border",
  dividerText: "text-text-muted",
  socialButtonsBlockButton: [
    "bg-bg-elevated border border-border hover:bg-bg-subtle hover:border-border-strong",
    "text-text rounded-lg h-11 min-w-[44px] transition-colors",
  ].join(" "),
  socialButtonsBlockButtonText: "text-text font-semibold",
  alternativeMethodsBlockButton: [
    "bg-bg-elevated border border-border hover:bg-bg-subtle",
    "text-text rounded-lg h-11",
  ].join(" "),
  formResendCodeLink: "text-accent hover:text-accent-hover",
  otpCodeFieldInput:
    "bg-bg-elevated border border-border text-text rounded-lg",
};

export const clerkAppearanceDark: Appearance = {
  variables: { ...SHARED_VARS, ...DARK_VARS },
  elements: SHARED_ELEMENTS,
};

export const clerkAppearanceLight: Appearance = {
  variables: { ...SHARED_VARS, ...LIGHT_VARS },
  elements: SHARED_ELEMENTS,
};

export function appearanceFor(theme: Theme): Appearance {
  return theme === "dark" ? clerkAppearanceDark : clerkAppearanceLight;
}
