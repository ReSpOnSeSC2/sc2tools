"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/Card";
import { RequestError, type RequestErrorProps } from "@/components/ui/RequestError";

/**
 * QueryState — the four states of a data request, in one order:
 * loading, failed, empty, ready.
 *
 *   <QueryState
 *     q={useApi<Row[]>(path)}
 *     skeleton={<Skeleton rows={4} />}
 *     isEmpty={(rows) => rows.length === 0}
 *     empty={<NoFilterMatches />}
 *     filtered
 *   >
 *     {(rows) => <Table rows={rows} />}
 *   </QueryState>
 *
 * The point is the order. A failed request shows RequestError with
 * Retry, never the empty state: "no matchups match" while the server
 * is down tells the user something false about their games.
 *
 *   - Loading, with nothing to show yet: `skeleton`.
 *   - Failed, with nothing current to show: RequestError (Retry calls
 *     `q.mutate()`). If the failure was only a background refresh of
 *     data already on screen, the data stays; the connection banner
 *     covers a dropped connection.
 *   - `isEmpty(data)`: `empty`.
 *   - Otherwise `children(data)`.
 *
 * While a filter change is loading, `data` is still the previous answer
 * (useApi keeps it within the same account and resource), so the view
 * doesn't flash a skeleton; `children` gets `{ isPreviousData }` to dim
 * it if it wants to.
 *
 * Views that compute a lot from the data can use the early-return form
 * with {@link hasQueryData}:
 *
 *   if (!hasQueryData(q)) return <QueryState q={q} skeleton={…} />;
 *   const data = q.data; // typed T
 */
export interface QueryLike<T> {
  data: T | undefined;
  error?: unknown;
  /** Set by useApi while `data` is the previous request's answer. */
  isPreviousData?: boolean;
  /** Re-run the request; SWR's bound `mutate` fits. */
  mutate: () => unknown;
}

export interface QueryStateProps<T> {
  q: QueryLike<T>;
  /** Shown while the first answer loads. Shape it like the content so nothing jumps. */
  skeleton?: ReactNode;
  /** Decides whether the answer counts as empty. */
  isEmpty?: (data: T) => boolean;
  /** Shown when `isEmpty(data)` is true. */
  empty?: ReactNode;
  /** Wraps the error in a Card with this heading (see RequestError). */
  errorTitle?: ReactNode;
  /** Adds "Your filters are still applied." to the error. */
  filtered?: boolean;
  /** Per-kind copy overrides for the error (see RequestError). */
  errorCopy?: RequestErrorProps["copy"];
  /**
   * Replace the error branch for some failures, e.g. a 404 that means
   * "not in your history" rather than "something broke". Return
   * undefined to fall back to RequestError.
   */
  renderError?: (error: unknown, retry: () => unknown) => ReactNode | undefined;
  /** The ready state. Omit for the early-return form. */
  children?: (data: T, state: { isPreviousData: boolean }) => ReactNode;
}

/**
 * True when the query has data that belongs on screen: an answer for the
 * current request, or the previous one while a new one loads. False
 * while the first answer loads and when the current request failed.
 */
export function hasQueryData<T>(q: QueryLike<T>): q is QueryLike<T> & { data: T } {
  if (q.data === undefined) return false;
  return !(q.error && q.isPreviousData);
}

export function QueryState<T>({
  q,
  skeleton = <Skeleton rows={4} />,
  isEmpty,
  empty,
  errorTitle,
  filtered = false,
  errorCopy,
  renderError,
  children,
}: QueryStateProps<T>) {
  if (hasQueryData(q)) {
    if (empty !== undefined && isEmpty?.(q.data)) return <>{empty}</>;
    return <>{children ? children(q.data, { isPreviousData: Boolean(q.isPreviousData) }) : null}</>;
  }
  if (q.error) {
    const retry = () => q.mutate();
    const custom = renderError?.(q.error, retry);
    if (custom !== undefined) return <>{custom}</>;
    return (
      <RequestError
        error={q.error}
        onRetry={retry}
        title={errorTitle}
        filtered={filtered}
        copy={errorCopy}
      />
    );
  }
  // Loading, or waiting for sign-in to settle before the request starts.
  return <>{skeleton}</>;
}
