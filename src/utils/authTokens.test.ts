import { describe, expect, it } from "vitest";
import {
  REFRESH_MAX_ATTEMPTS,
  RefreshError,
  classifyRefreshError,
  classifyRefreshStatus,
  computeNextTokenRefresh,
  getJwtExpMs,
  shouldRetryRefresh,
} from "./authTokens";

/** Build an unsigned JWT (`header.payload.sig`) with the given payload. */
function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

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

describe("getJwtExpMs", () => {
  it("returns the exp claim in epoch-ms", () => {
    expect(getJwtExpMs(makeJwt({ exp: 1_700_000_000 }))).toBe(
      1_700_000_000_000,
    );
  });

  it("accepts a capitalised Exp claim", () => {
    expect(getJwtExpMs(makeJwt({ Exp: 1_700_000_000 }))).toBe(
      1_700_000_000_000,
    );
  });

  it("returns null when there is no usable exp", () => {
    expect(getJwtExpMs(makeJwt({ sub: "1" }))).toBeNull();
    expect(getJwtExpMs(makeJwt({ exp: "soon" }))).toBeNull();
  });

  it("returns null for a non-JWT / garbage string", () => {
    expect(getJwtExpMs("not.a.jwt")).toBeNull();
    expect(getJwtExpMs("garbage")).toBeNull();
    expect(getJwtExpMs("")).toBeNull();
  });
});

describe("computeNextTokenRefresh", () => {
  it("uses the token's real exp claim", () => {
    const expSec = Math.floor(Date.now() / 1000) + 300;
    expect(computeNextTokenRefresh(makeJwt({ exp: expSec })).getTime()).toBe(
      expSec * 1000,
    );
  });

  it("falls back to a short window for a token with no readable exp", () => {
    const floor = Date.now() + 4 * 60_000;
    const next = computeNextTokenRefresh("garbage").getTime();
    expect(next).toBeGreaterThanOrEqual(floor);
    expect(next).toBeLessThanOrEqual(Date.now() + 4 * 60_000 + 2_000);
  });
});
