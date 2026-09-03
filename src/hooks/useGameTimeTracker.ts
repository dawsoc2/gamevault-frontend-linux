import { useEffect, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import { useOnlineStatus } from "@/context/OfflineContext";
import { isTauriApp } from "@/utils/tauri";
import { getRootPaths } from "@/utils/rootPaths";

export function useGameTimeTracker() {
  const { serverUrl, user, auth } = useAuth();
  const { onReconnect } = useOnlineStatus();
  const startedRef = useRef<{ serverUrl: string; userId: number } | null>(null);
  const syncInFlightRef = useRef(false);
  const initialSyncDoneRef = useRef(false);

  // Start / restart tracker as soon as credentials are available. We key the
  // "started" state on server+user so a token refresh (handled by
  // update_tracker_auth) doesn't restart the 60s polling loop.
  useEffect(() => {
    if (!isTauriApp()) return;

    const userId = user?.id;
    const accessToken = auth?.access_token;
    const downloadPaths = getRootPaths().map((p) => p.path);

    if (!serverUrl || !userId || !accessToken || !downloadPaths.length) {
      // If tracker was running but credentials are gone (logout), stop it
      if (startedRef.current) {
        startedRef.current = null;
        console.info("[time-tracker] stopping (credentials cleared)");
        import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("stop_game_time_tracker").catch((e) =>
            console.warn("[time-tracker] stop_game_time_tracker failed", e),
          );
        });
      }
      return;
    }

    const started = startedRef.current;
    if (
      started &&
      started.serverUrl === serverUrl &&
      started.userId === userId
    ) {
      // Same session (token may have refreshed); leave the loop running.
      return;
    }

    // New session or a changed server/user — (re)start with fresh credentials.
    if (started) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("stop_game_time_tracker").catch((e) =>
          console.warn("[time-tracker] stop_game_time_tracker failed", e),
        );
      });
    }
    startedRef.current = { serverUrl, userId };
    console.info("[time-tracker] starting", { serverUrl, userId, downloadPaths });
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("start_game_time_tracker", {
        serverUrl,
        userId,
        accessToken,
        downloadPath: null,
        downloadPaths,
      }).catch((e) =>
        console.warn("[time-tracker] start_game_time_tracker failed", e),
      );
    });
  }, [serverUrl, user?.id, auth?.access_token]);

  // Stop the tracker on unmount.
  useEffect(() => {
    return () => {
      startedRef.current = null;
      if (!isTauriApp()) return;
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("stop_game_time_tracker").catch((e) =>
          console.warn("[time-tracker] stop_game_time_tracker failed", e),
        );
      });
    };
  }, []);

  // Update auth token separately to avoid restarting the whole tracker on refresh
  useEffect(() => {
    if (!isTauriApp() || !startedRef.current) return;
    const accessToken = auth?.access_token;
    if (!accessToken) return;

    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke("update_tracker_auth", { accessToken }).catch((e) =>
        console.warn("[time-tracker] update_tracker_auth failed", e),
      );
    });
  }, [auth?.access_token]);

  // Sync any lingering offline time on startup (handles case where user
  // went offline, closed the app, then restarted while online)
  useEffect(() => {
    if (!isTauriApp()) return;
    if (!serverUrl || !auth?.access_token) return;
    if (initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;

    (async () => {
      try {
        const rootPaths = getRootPaths();
        if (!rootPaths.length) return;

        const { invoke } = await import("@tauri-apps/api/core");

        for (const root of rootPaths) {
          const files = await invoke<any[]>("get_offline_time_files", {
            selectedRoot: root.path,
          }).catch(() => [] as any[]);

          for (const file of files) {
            if (!file.accumulatedMinutes || file.accumulatedMinutes <= 0) {
              await invoke("delete_offline_time_file", {
                path: file.path,
              }).catch(() => {});
              continue;
            }

            try {
              const success = await invoke<boolean>("sync_offline_time", {
                serverUrl,
                accessToken: auth.access_token,
                userId: file.userId,
                gameId: file.gameId,
                minutes: file.accumulatedMinutes,
              });

              if (success) {
                await invoke("delete_offline_time_file", {
                  path: file.path,
                }).catch(() => {});
              }
            } catch {
              // Retry on next reconnect
            }
          }
        }
      } catch {
        // Silently fail
      }
    })();
  }, [serverUrl, auth?.access_token]);

  // Sync offline time when coming back online
  useEffect(() => {
    if (!isTauriApp()) return;

    const unregister = onReconnect(async () => {
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;

      try {
        const rootPaths = getRootPaths();
        if (!rootPaths.length) return;

        const { invoke } = await import("@tauri-apps/api/core");

        for (const root of rootPaths) {
          const files = await invoke<any[]>("get_offline_time_files", {
            selectedRoot: root.path,
          }).catch(() => [] as any[]);

          for (const file of files) {
            if (!file.accumulatedMinutes || file.accumulatedMinutes <= 0) {
              // Delete empty files
              await invoke("delete_offline_time_file", {
                path: file.path,
              }).catch(() => {});
              continue;
            }

            try {
              const success = await invoke<boolean>("sync_offline_time", {
                serverUrl,
                accessToken: auth?.access_token || "",
                userId: file.userId,
                gameId: file.gameId,
                minutes: file.accumulatedMinutes,
              });

              if (success) {
                await invoke("delete_offline_time_file", {
                  path: file.path,
                }).catch(() => {});
              }
            } catch {
              // Retry on next reconnect
            }
          }
        }
      } catch {
        // Silently fail — retry on next reconnect
      } finally {
        syncInFlightRef.current = false;
      }
    });

    return unregister;
  }, [onReconnect, serverUrl, auth?.access_token]);
}
