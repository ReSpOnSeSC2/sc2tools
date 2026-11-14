export function isBalanceToolPath(pathname: string | null) {
  return pathname === "/permit" || pathname === "/balance" || Boolean(pathname?.startsWith("/balance/"));
}
