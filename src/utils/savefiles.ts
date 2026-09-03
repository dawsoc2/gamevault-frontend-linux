/**
 * Client-side helpers for cloud save syncing (Ludusavi-backed).
 *
 * The heavy lifting lives in the Rust `savefile_*` commands; this module holds
 * the browser-side glue: the global on/off flag, the per-installation UUID kept
 * in `.gamevault.game.config.json`, and the "last synced" markers shown in the
 * UI.
 */

import type { GameVaultConfig } from "@/models/gamevaultconfig";

const CLOUD_SAVES_ENABLED_KEY = "cloud_saves_enabled";

export function isCloudSavesEnabled(): boolean {
  try {
    return localStorage.getItem(CLOUD_SAVES_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCloudSavesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(CLOUD_SAVES_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** In-memory cache of `savefile_probe` results, keyed by lower-cased game title. */
export const probeCache = new Map<
  string,
  { recognized: boolean; canonicalName: string | null }
>();

const GAME_CONFIG_FILE = ".gamevault.game.config.json";

/**
 * Return the installation's UUID, generating and persisting one into the
 * per-version game config on first use. Mirrors the config read/write dance in
 * GameSettings' `persistLaunchOptions`.
 */
export async function ensureInstallationId(
  versionDirectory: string,
): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { join } = await import("@tauri-apps/api/path");
  const configPath = await join(versionDirectory, GAME_CONFIG_FILE);

  let config: Partial<GameVaultConfig> = {};
  if (await invoke<boolean>("fs_path_exists", { path: configPath })) {
    try {
      config = JSON.parse(
        await invoke<string>("fs_read_text_file", { path: configPath }),
      ) as Partial<GameVaultConfig>;
    } catch {
      config = {};
    }
  }

  if (config.installationid && /^[0-9a-f-]{36}$/i.test(config.installationid)) {
    return config.installationid;
  }

  const id = crypto.randomUUID();
  config.installationid = id;
  await invoke("fs_write_text_file", {
    path: configPath,
    content: JSON.stringify(config, null, 2),
  });
  return id;
}

export interface LastSynced {
  direction: "upload" | "download";
  at: number;
}

function lastSyncedKey(gameId: number, installationId: string): string {
  return `save_sync_last:${gameId}:${installationId}`;
}

export function getLastSynced(
  gameId: number,
  installationId: string,
): LastSynced | null {
  try {
    const raw = localStorage.getItem(lastSyncedKey(gameId, installationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastSynced;
    if (
      (parsed.direction === "upload" || parsed.direction === "download") &&
      typeof parsed.at === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setLastSynced(
  gameId: number,
  installationId: string,
  direction: LastSynced["direction"],
): void {
  try {
    localStorage.setItem(
      lastSyncedKey(gameId, installationId),
      JSON.stringify({ direction, at: Date.now() } satisfies LastSynced),
    );
  } catch {
    /* ignore */
  }
}
