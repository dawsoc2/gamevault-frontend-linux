/**
 * How a failed token refresh should be handled.
 *
 * - `fatal`: the server rejected the refresh token itself (HTTP 400/401/403 from
 *   `POST /api/auth/refresh`). GameVault returns 401 "token has been revoked"
 *   once a refresh token has been rotated away, and 400 for a malformed/expired
 *   one. There is no recovery — the session is gone and the user must sign in.
 * - `transient`: a network error, timeout, or server-side problem (5xx, 429).
 *   The refresh token is probably still valid; retrying later should work, so we
 *   keep it and (on desktop) fall back to offline mode.
 */
export type RefreshFailureKind = "fatal" | "transient";

/**
 * Error thrown by the token-refresh request, tagged with its
 * {@link RefreshFailureKind} so callers can decide between logging out and
 * dropping into offline mode.
 */
export class RefreshError extends Error {
  readonly kind: RefreshFailureKind;
  readonly status?: number;

  constructor(kind: RefreshFailureKind, message: string, status?: number) {
    super(message);
    this.name = "RefreshError";
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Map an HTTP status from `POST /api/auth/refresh` to a failure kind. 400/401/403
 * mean the refresh token is dead; every other status is treated as a temporary
 * server/network problem (including unexpected 2xx/3xx and 404 from a proxy).
 */
export function classifyRefreshStatus(status: number): RefreshFailureKind {
  return status === 400 || status === 401 || status === 403
    ? "fatal"
    : "transient";
}

/**
 * Classify a value thrown while refreshing. A {@link RefreshError} carries its
 * own kind; anything else (network `TypeError`, `AbortError`/`TimeoutError` from
 * a timeout, a JSON parse failure, ...) is transient.
 */
export function classifyRefreshError(err: unknown): RefreshFailureKind {
  return err instanceof RefreshError ? err.kind : "transient";
}
