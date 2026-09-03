import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked Tauri command surface used by ensureInstallationId.
const files = new Map<string, string>();
const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  switch (cmd) {
    case "fs_path_exists":
      return files.has(args.path as string);
    case "fs_read_text_file":
      return files.get(args.path as string) ?? "";
    case "fs_write_text_file":
      files.set(args.path as string, args.content as string);
      return null;
    default:
      throw new Error(`unexpected command ${cmd}`);
  }
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/path", () => ({
  join: async (...parts: string[]) => parts.join("/"),
}));

import {
  ensureInstallationId,
  getLastSynced,
  isCloudSavesEnabled,
  setCloudSavesEnabled,
  setLastSynced,
} from "./savefiles";

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
  files.clear();
  invoke.mockClear();
  installMemoryLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloud saves flag", () => {
  it("defaults to off and round-trips", () => {
    expect(isCloudSavesEnabled()).toBe(false);
    setCloudSavesEnabled(true);
    expect(isCloudSavesEnabled()).toBe(true);
    setCloudSavesEnabled(false);
    expect(isCloudSavesEnabled()).toBe(false);
  });
});

describe("ensureInstallationId", () => {
  it("generates and persists a UUID when the config has none", async () => {
    const id = await ensureInstallationId("/games/MyGame/Versions/(1) 1.0");
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    const written = JSON.parse(
      files.get("/games/MyGame/Versions/(1) 1.0/.gamevault.game.config.json")!,
    );
    expect(written.installationid).toBe(id);
  });

  it("reuses an existing id and does not rewrite the config", async () => {
    const configPath =
      "/games/MyGame/Versions/(1) 1.0/.gamevault.game.config.json";
    files.set(
      configPath,
      JSON.stringify({
        installationid: "11111111-1111-4111-8111-111111111111",
        launchexecutable: "game.sh",
      }),
    );

    const id = await ensureInstallationId("/games/MyGame/Versions/(1) 1.0");
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
    expect(invoke).not.toHaveBeenCalledWith(
      "fs_write_text_file",
      expect.anything(),
    );
  });

  it("preserves other config fields when adding the id", async () => {
    const configPath =
      "/games/MyGame/Versions/(1) 1.0/.gamevault.game.config.json";
    files.set(
      configPath,
      JSON.stringify({ launchexecutable: "game.sh", launchasadmin: true }),
    );

    await ensureInstallationId("/games/MyGame/Versions/(1) 1.0");

    const written = JSON.parse(files.get(configPath)!);
    expect(written.launchexecutable).toBe("game.sh");
    expect(written.launchasadmin).toBe(true);
    expect(written.installationid).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("last synced markers", () => {
  it("round-trips per game + installation", () => {
    expect(getLastSynced(7, "inst-a")).toBeNull();

    setLastSynced(7, "inst-a", "upload");
    const marker = getLastSynced(7, "inst-a");
    expect(marker?.direction).toBe("upload");
    expect(typeof marker?.at).toBe("number");

    // Different installation is tracked separately.
    expect(getLastSynced(7, "inst-b")).toBeNull();
  });
});
