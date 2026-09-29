/**
 * GA4 ``sign_up`` event, sent once for a brand-new account.
 *
 * Clerk finishes sign-up on its own pages and then redirects (to /welcome,
 * or back to /try), so there is no single "account created" callback in
 * this app. Instead the first page a new account loads with GA running
 * reports it: the Clerk user was created within the last 30 minutes and
 * this browser hasn't reported that user yet.
 *
 * Example:
 *   shouldTrackSignUp({ userId: "user_1", createdAt, now, trackedUserId: null }); // -> true
 */

/** How recent an account must be to count as "just signed up". */
export const SIGN_UP_WINDOW_MS = 30 * 60 * 1000;

/** localStorage key holding the Clerk id of the last account reported. */
export const SIGN_UP_TRACKED_KEY = "sc2tools.signUpTracked.v1";

export interface SignUpCheck {
  userId: string;
  createdAt: Date | null | undefined;
  now: number;
  trackedUserId: string | null;
}

/** Whether this account's sign-up should be reported now. */
export function shouldTrackSignUp({ userId, createdAt, now, trackedUserId }: SignUpCheck): boolean {
  if (!userId || !createdAt || trackedUserId === userId) return false;
  const age = now - createdAt.getTime();
  return Number.isFinite(age) && age >= 0 && age <= SIGN_UP_WINDOW_MS;
}

/**
 * The ``method`` parameter: the social provider the account signed up
 * with ("google", "discord", "twitch"), else "email".
 *
 * Example: `signUpMethod([{ provider: "google" }])` → "google".
 */
export function signUpMethod(
  externalAccounts: ReadonlyArray<{ provider?: string | null }> | null | undefined,
): string {
  const provider = externalAccounts?.find((account) => account?.provider)?.provider;
  return provider ? provider.replace(/^oauth_/, "") : "email";
}

/** Clerk id of the account this browser already reported, if any. */
export function readTrackedSignUp(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SIGN_UP_TRACKED_KEY);
  } catch {
    return null;
  }
}

/** Remember that this account's sign-up was reported on this browser. */
export function rememberTrackedSignUp(userId: string): void {
  try {
    window.localStorage.setItem(SIGN_UP_TRACKED_KEY, userId);
  } catch {
    // Storage blocked: the 30-minute window still bounds any repeat.
  }
}
