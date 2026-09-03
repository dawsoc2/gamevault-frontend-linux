import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTrailerAutoplayEnabled, setTrailerAutoplayEnabled } from "./media";

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trailer autoplay flag", () => {
  it("defaults to off and round-trips", () => {
    expect(isTrailerAutoplayEnabled()).toBe(false);
    setTrailerAutoplayEnabled(true);
    expect(isTrailerAutoplayEnabled()).toBe(true);
    setTrailerAutoplayEnabled(false);
    expect(isTrailerAutoplayEnabled()).toBe(false);
  });
});
