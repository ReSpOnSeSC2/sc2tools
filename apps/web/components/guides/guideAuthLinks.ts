/** Preserve guide context for existing accounts. auth-return-to-context
 * (wave 5) will unify this with the onboarding return flow. */
export function guideSignInHref(path: string | null): string {
  return path && /^\/guides(?:\/[a-z0-9-]+){0,3}$/.test(path)
    ? `/sign-in?redirect_url=${encodeURIComponent(path)}` : "/sign-in";
}
