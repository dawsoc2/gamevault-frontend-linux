import { useCallback, useEffect, useRef, useState } from "react";
import type { GamevaultGame } from "@/api/models/GamevaultGame";
import { useAuth } from "@/context/AuthContext";
import type { InstalledGameInfo } from "@/hooks/useInstalledGames";
import { isTauriApp } from "@/utils/tauri";
import { getRootPaths } from "@/utils/rootPaths";
import {
  ensureInstallationId,
  getLastSynced,
  isCloudSavesEnabled,
  probeCache,
  setLastSynced,
  type LastSynced,
} from "@/utils/savefiles";

export type SaveSyncStatus =
  | "idle" // not applicable (web build, feature off, no title)
  | "checking"
  | "compatible" // Ludusavi recognises this game
  | "incompatible" // Ludusavi does not recognise it
  | "unavailable"; // server has savefile uploads disabled

export interface SaveSyncResult {
  action: "upload" | "download";
  message: string;
  ok: boolean;
}

interface BackupResult {
  zipPath: string;
  files: number;
  bytes: number;
}
interface RestoreResult {
  restoredFiles: number;
}
interface ProbeResult {
  recognized: boolean;
  canonicalName: string | null;
}

/**
 * Cloud save state for one game: a Ludusavi-driven compatibility check plus
 * explicit upload/download against the server's `/api/savefiles` endpoints.
 * Everything is a no-op outside the Tauri desktop build.
 */
export function useSaveSync(
  game: GamevaultGame | null,
  installedInfo: InstalledGameInfo | undefined,
) {
  const { serverUrl, authFetch, user } = useAuth();
  const [status, setStatus] = useState<SaveSyncStatus>("idle");
  const [busy, setBusy] = useState<null | "upload" | "download">(null);
  const [canonicalName, setCanonicalName] = useState<string | null>(null);
  const [lastSynced, setLastSyncedState] = useState<LastSynced | null>(null);
  const installIdRef = useRef<string | null>(null);

  const enabled = isTauriApp() && isCloudSavesEnabled();
  const title = game?.metadata?.title || game?.title || "";
  const gameId = game?.id ?? null;
  const userId = (user as { id?: number } | null)?.id ?? null;

  // Compatibility probe (cached across the session).
  useEffect(() => {
    if (!enabled || !title) {
      setStatus("idle");
      return;
    }

    const key = title.toLowerCase();
    const cached = probeCache.get(key);
    if (cached) {
      setCanonicalName(cached.canonicalName);
      setStatus(cached.recognized ? "compatible" : "incompatible");
      return;
    }

    let cancelled = false;
    setStatus("checking");
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<ProbeResult>("savefile_probe", { title });
        if (cancelled) return;
        probeCache.set(key, {
          recognized: result.recognized,
          canonicalName: result.canonicalName,
        });
        setCanonicalName(result.canonicalName);
        setStatus(result.recognized ? "compatible" : "incompatible");
      } catch {
        if (!cancelled) setStatus("incompatible");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, title]);

  // Load the "last synced" marker once we know the installation id.
  useEffect(() => {
    if (!enabled || !installedInfo || gameId == null) {
      setLastSyncedState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const id = await ensureInstallationId(installedInfo.versionDirectory);
        if (cancelled) return;
        installIdRef.current = id;
        setLastSyncedState(getLastSynced(gameId, id));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, installedInfo, gameId]);

  const base = serverUrl.replace(/\/+$/, "");

  const upload = useCallback(async (): Promise<SaveSyncResult> => {
    if (!installedInfo || !canonicalName || gameId == null || userId == null) {
      return {
        action: "upload",
        ok: false,
        message: "Cloud saves are not available for this game.",
      };
    }
    setBusy("upload");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const installId =
        installIdRef.current ??
        (await ensureInstallationId(installedInfo.versionDirectory));
      installIdRef.current = installId;

      const backup = await invoke<BackupResult>("savefile_backup", {
        canonicalName,
        libraryRoots: getRootPaths().map((r) => r.path),
      });

      if (!backup.files || !backup.zipPath) {
        return {
          action: "upload",
          ok: false,
          message: "No local save files were found for this game.",
        };
      }

      const bytes = await invoke<number[]>("fs_read_binary_file", {
        path: backup.zipPath,
      });
      const file = new File([new Uint8Array(bytes)], "savefile.zip", {
        type: "application/zip",
      });
      const form = new FormData();
      form.append("file", file, "savefile.zip");

      const res = await authFetch(
        `${base}/api/savefiles/user/${userId}/game/${gameId}`,
        {
          method: "POST",
          body: form,
          headers: { "X-Installation-Id": installId },
        },
      );

      await invoke("fs_remove", {
        path: backup.zipPath,
        recursive: false,
      }).catch(() => {});

      if (res.status === 403 || res.status === 404) {
        setStatus("unavailable");
        return {
          action: "upload",
          ok: false,
          message: "This server has cloud saves disabled.",
        };
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")) || res.statusText;
        return {
          action: "upload",
          ok: false,
          message: `Upload failed (${res.status}): ${detail}`,
        };
      }

      setLastSynced(gameId, installId, "upload");
      setLastSyncedState(getLastSynced(gameId, installId));
      return {
        action: "upload",
        ok: true,
        message: `Uploaded ${backup.files} save file${backup.files === 1 ? "" : "s"} to the server.`,
      };
    } catch (e) {
      return {
        action: "upload",
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      setBusy(null);
    }
  }, [installedInfo, canonicalName, gameId, userId, authFetch, base]);

  const download = useCallback(async (): Promise<SaveSyncResult> => {
    if (!installedInfo || !canonicalName || gameId == null || userId == null) {
      return {
        action: "download",
        ok: false,
        message: "Cloud saves are not available for this game.",
      };
    }
    setBusy("download");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const installId =
        installIdRef.current ??
        (await ensureInstallationId(installedInfo.versionDirectory));
      installIdRef.current = installId;

      const res = await authFetch(
        `${base}/api/savefiles/user/${userId}/game/${gameId}`,
        { method: "GET" },
      );

      if (res.status === 404) {
        return {
          action: "download",
          ok: false,
          message: "There is no save on the server for this game yet.",
        };
      }
      if (res.status === 403) {
        setStatus("unavailable");
        return {
          action: "download",
          ok: false,
          message: "This server has cloud saves disabled.",
        };
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")) || res.statusText;
        return {
          action: "download",
          ok: false,
          message: `Download failed (${res.status}): ${detail}`,
        };
      }

      // Usually a raw zip stream; tolerate an older backend that JSON-wraps it
      // as a Node Buffer (`{ type: "Buffer", data: [...] }`).
      let zipBytes: number[];
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const parsed = (await res.json()) as { data?: number[] };
        zipBytes = Array.isArray(parsed?.data) ? parsed.data : [];
      } else {
        zipBytes = Array.from(new Uint8Array(await res.arrayBuffer()));
      }
      if (!zipBytes.length) {
        return {
          action: "download",
          ok: false,
          message: "The server returned an empty save file.",
        };
      }

      const result = await invoke<RestoreResult>("savefile_restore", {
        canonicalName,
        zipBytes,
      });

      setLastSynced(gameId, installId, "download");
      setLastSyncedState(getLastSynced(gameId, installId));
      return {
        action: "download",
        ok: true,
        message: `Restored ${result.restoredFiles} save file${result.restoredFiles === 1 ? "" : "s"} from the server.`,
      };
    } catch (e) {
      return {
        action: "download",
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    } finally {
      setBusy(null);
    }
  }, [installedInfo, canonicalName, gameId, userId, authFetch, base]);

  return {
    /** Whether the feature is active in this build/session. */
    enabled,
    status,
    busy,
    lastSynced,
    /** True when an installed, recognised game can actually be synced now. */
    canSync: enabled && !!installedInfo && status === "compatible",
    upload,
    download,
  };
}
