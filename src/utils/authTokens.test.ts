import { describe, expect, it } from "vitest";
import {
  REFRESH_MAX_ATTEMPTS,
  RefreshError,
  classifyRefreshError,
  classifyRefreshStatus,
  shouldRetryRefresh,
} from "./authTokens";

describe("classifyRefreshStatus", () => {
  it("treats 400/401/403 as fatal (the refresh token is dead)", () => {
    expect(classifyRefreshStatus(400)).toBe("fatal");
    expect(classifyRefreshStatus(401)).toBe("fatal");
    expect(classifyRefreshStatus(403)).toBe("fatal");
  });

  it("treats server/rate-limit statuses as transient", () => {
    expect(classifyRefreshStatus(429)).toBe("transient");
    expect(classifyRefreshStatus(500)).toBe("transient");
    expect(classifyRefreshStatus(502)).toBe("transient");
    expect(classifyRefreshStatus(503)).toBe("transient");
    expect(classifyRefreshStatus(504)).toBe("transient");
  });

  it("treats unexpected non-auth statuses as transient", () => {
    expect(classifyRefreshStatus(200)).toBe("transient");
    expect(classifyRefreshStatus(404)).toBe("transient");
  });
});

describe("classifyRefreshError", () => {
  it("uses the kind carried by a RefreshError", () => {
    expect(
      classifyRefreshError(new RefreshError("fatal", "revoked", 401)),
    ).toBe("fatal");
    expect(
      classifyRefreshError(new RefreshError("transient", "server down", 503)),
    ).toBe("transient");
  });

  it("treats any other throw as transient", () => {
    expect(classifyRefreshError(new TypeError("Failed to fetch"))).toBe(
      "transient",
    );
    expect(classifyRefreshError(new Error("boom"))).toBe("transient");
    expect(classifyRefreshError("nope")).toBe("transient");
    expect(classifyRefreshError(undefined)).toBe("transient");
  });
});

describe("shouldRetryRefresh", () => {
  it("retries transient failures until the attempt cap", () => {
    expect(shouldRetryRefresh(1, new TypeError("network"))).toBe(true);
    expect(
      shouldRetryRefresh(REFRESH_MAX_ATTEMPTS - 1, new TypeError("x")),
    ).toBe(true);
    expect(shouldRetryRefresh(REFRESH_MAX_ATTEMPTS, new TypeError("x"))).toBe(
      false,
    );
  });

  it("never retries a fatal (rejected-token) failure", () => {
    expect(
      shouldRetryRefresh(1, new RefreshError("fatal", "revoked", 401)),
    ).toBe(false);
  });

  it("retries a transient RefreshError (5xx / 429)", () => {
    expect(
      shouldRetryRefresh(1, new RefreshError("transient", "bad gateway", 502)),
    ).toBe(true);
  });
});

describe("RefreshError", () => {
  it("is an Error with a stable name and the given fields", () => {
    const err = new RefreshError("fatal", "token has been revoked", 401);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RefreshError);
    expect(err.name).toBe("RefreshError");
    expect(err.kind).toBe("fatal");
    expect(err.status).toBe(401);
    expect(err.message).toBe("token has been revoked");
  });
});
