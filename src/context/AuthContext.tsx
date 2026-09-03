import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { GamevaultUser } from "../api";
import { AuthTokens } from "../types/AuthTokens";
import {
  AUTH_REFRESH_STORAGE_KEY,
  AUTH_SERVER_STORAGE_KEY,
  getDevAutologinConfig,
  normalizeServerUrl,
} from "@/utils/authConfig";
import { isTauriApp } from "@/utils/tauri";
import {
  RefreshError,
  classifyRefreshError,
  classifyRefreshStatus,
  computeNextTokenRefresh,
  getJwtExpMs,
  shouldRetryRefresh,
} from "@/utils/authTokens";
import { useOnlineStatus } from "@/context/OfflineContext";

const AUTH_CACHED_USER_KEY = "app_cached_user";

/** Per-attempt timeout for POST /api/auth/refresh. */
const REFRESH_TIMEOUT_MS = 15_000;
/** Backoff before retry attempts 2 and 3 (indices 0 and 1). */
const REFRESH_RETRY_DELAYS_MS = [1_000, 3_000];
/**
 * How far before the access token's expiry to refresh it — used both by the
 * proactive timer and by isTokenNearExpiry's lazy check so they agree.
 */
const REFRESH_LEAD_MS = 90_000;

interface LoginArgs {
  server: string;
  username: string;
  password: string;
}

interface AuthContextValue {
  serverUrl: string;
  auth: AuthTokens | null;
  user: GamevaultUser | null;
  error: string | null;
  loading: boolean;
  bootstrapping: boolean;
  /** True when the app started in offline mode (cached credentials used) */
  offlineBootstrap: boolean;
  loginBasic: (
    args: LoginArgs,
  ) => Promise<{ auth: AuthTokens; user: GamevaultUser }>;
  /** Directly initialize auth state from already obtained tokens (e.g. SSO redirect). */
  loginWithTokens: (
    server: string,
    tokens: AuthTokens,
  ) => Promise<{ auth: AuthTokens; user: GamevaultUser }>;
  logout: () => void;
  authFetch: (input: string, init?: RequestInit) => Promise<Response>;
  refreshCurrentUser: () => Promise<GamevaultUser | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [serverUrl, setServerUrl] = useState("");
  const [auth, setAuth] = useState<AuthTokens | null>(null);
  const [user, setUser] = useState<GamevaultUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [offlineBootstrap, setOfflineBootstrap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bootstrapRanRef = useRef(false);

  const authRef = useRef<AuthTokens | null>(null);
  const serverRef = useRef("");
  const nextTokenRefreshRef = useRef<Date | null>(null);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  /** When true, ensureFreshToken is a no-op — used during offline mode */
  const offlineModeRef = useRef(false);
  /** Cooldown timestamp (ms) — skip refresh retries until after this time */
  const offlineRefreshCooldownRef = useRef(0);

  const { onReconnect } = useOnlineStatus();

  async function loginBasicRequest(
    username: string,
    password: string,
  ): Promise<AuthTokens> {
    const res = await fetch(`${serverRef.current}/api/auth/basic/login`, {
      method: "GET",
      headers: {
        Authorization: "Basic " + btoa(`${username}:${password}`),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      throw new Error(
        `Login failed (${res.status}): ${(await res.text()) || res.statusText}`,
      );
    return res.json();
  }
  async function refreshOnce(refreshToken: string): Promise<AuthTokens> {
    const res = await fetch(`${serverRef.current}/api/auth/refresh`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + refreshToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")) || res.statusText;
      throw new RefreshError(
        classifyRefreshStatus(res.status),
        `Refresh failed (${res.status}): ${detail}`,
        res.status,
      );
    }
    return res.json();
  }
  /**
   * Refresh, retrying transient failures (network error, timeout, 5xx/429) a few
   * times so a brief blip doesn't strand the client on a token the server has
   * already rotated away. A fatal RefreshError (400/401/403) is re-thrown at once.
   */
  async function refreshWithToken(refreshToken: string): Promise<AuthTokens> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await refreshOnce(refreshToken);
      } catch (e) {
        if (!shouldRetryRefresh(attempt, e)) throw e;
        const backoff = REFRESH_RETRY_DELAYS_MS[attempt - 1] ?? 3_000;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  async function fetchCurrentUser(): Promise<GamevaultUser> {
    const res = await authFetch(`${serverRef.current}/api/users/me`);
    if (!res.ok)
      throw new Error(
        `GET /api/users/me failed (${res.status}): ${(await res.text()) || res.statusText}`,
      );
    const me: GamevaultUser = await res.json();
    // Always cache user for offline bootstrap (Tauri only)
    if (isTauriApp()) {
      try {
        localStorage.setItem(AUTH_CACHED_USER_KEY, JSON.stringify(me));
      } catch { /* ignore */ }
    }
    return me;
  }

  const isTokenNearExpiry = useCallback(() => {
    const nxt = nextTokenRefreshRef.current;
    if (!nxt) return true;
    return nxt.getTime() <= Date.now() + REFRESH_LEAD_MS;
  }, []);

  const logout = useCallback(() => {
    offlineModeRef.current = false;
    authRef.current = null;
    nextTokenRefreshRef.current = null;
    setAuth(null);
    setUser(null);
    setError(null);
    localStorage.removeItem(AUTH_REFRESH_STORAGE_KEY);
  }, []);

  /**
   * Decide what to do when a token refresh fails:
   *  - fatal (server rejected the refresh token, HTTP 400/401/403): the session
   *    is gone — log out so the user lands on the sign-in screen.
   *  - transient (network error / timeout / 5xx): keep the token. On desktop,
   *    drop into offline mode with a cooldown so the cached UI keeps working;
   *    on the web there is nothing to fall back to, so log out.
   */
  const applyRefreshFailure = useCallback(
    (err: unknown) => {
      if (classifyRefreshError(err) === "fatal") {
        console.log("[auth] refresh rejected — session is gone, logging out");
        logout();
        return;
      }
      if (isTauriApp() && localStorage.getItem(AUTH_REFRESH_STORAGE_KEY)) {
        console.log(
          "[auth] refresh failed (transient) — entering offline mode, cooldown 30s",
        );
        offlineModeRef.current = true;
        offlineRefreshCooldownRef.current = Date.now() + 30_000;
      } else {
        logout();
      }
    },
    [logout],
  );

  /**
   * Refresh the token pair. All refresh traffic funnels through here: concurrent
   * callers (bootstrap, ensureFreshToken, the reconnect handler, and later the
   * proactive timer / authFetch's 401 retry) share one in-flight request so the
   * server's single-use refresh token is never spent twice in parallel.
   */
  const performRefresh = useCallback(async (): Promise<void> => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const run = (async () => {
      const refreshToken =
        authRef.current?.refresh_token ||
        localStorage.getItem(AUTH_REFRESH_STORAGE_KEY);
      if (!refreshToken) throw new Error("Missing refresh token");
      const data = await refreshWithToken(refreshToken);
      if (!data?.access_token)
        throw new Error("Refresh response missing access_token");
      const merged: AuthTokens = { ...(authRef.current || {}), ...data };
      // Persist the rotated refresh token first — synchronously, before any
      // React state update — so an interruption (crash, reload) can't leave the
      // next launch holding a token the server has already invalidated.
      if (merged.refresh_token)
        localStorage.setItem(AUTH_REFRESH_STORAGE_KEY, merged.refresh_token);
      authRef.current = merged;
      nextTokenRefreshRef.current = computeNextTokenRefresh(
        merged.access_token,
      );
      offlineModeRef.current = false; // successfully refreshed, exit offline mode
      setAuth(merged);
    })();
    refreshInFlightRef.current = run;
    try {
      await run;
    } finally {
      if (refreshInFlightRef.current === run) refreshInFlightRef.current = null;
    }
  }, []);
  const ensureFreshToken = useCallback(async () => {
    // A refresh is already in flight (another authFetch, the reconnect handler,
    // and later the proactive timer / authFetch's 401 retry) — just wait for it.
    if (refreshInFlightRef.current) {
      try {
        await refreshInFlightRef.current;
      } catch {
        /* the caller that initiated the refresh owns failure handling */
      }
      return;
    }
    // In offline mode: try the refresh. On success performRefresh clears
    // offlineModeRef and we exit offline mode; on failure applyRefreshFailure
    // either re-cools-down (transient) or logs out (dead token).
    if (offlineModeRef.current) {
      // Cooldown: don't spam failed refresh attempts while truly offline
      if (Date.now() < offlineRefreshCooldownRef.current) return;
      try {
        await performRefresh();
      } catch (e) {
        applyRefreshFailure(e);
      }
      return;
    }
    // Normal online path — only refresh when the token is close to expiring.
    if (!authRef.current?.access_token) return;
    if (!isTokenNearExpiry()) return;
    try {
      await performRefresh();
    } catch (e) {
      applyRefreshFailure(e);
    }
  }, [isTokenNearExpiry, performRefresh, applyRefreshFailure]);

  const authFetch = useCallback(
    async (input: string, init?: RequestInit) => {
      await ensureFreshToken();
      const send = () => {
        const token = authRef.current?.access_token;
        const headers = new Headers(init?.headers || {});
        if (token && !headers.has("Authorization"))
          headers.set("Authorization", "Bearer " + token);
        headers.set("Accept", "*/*");
        return fetch(input, { ...(init || {}), headers });
      };
      const res = await send();
      // One transparent retry on 401: an access token can be rejected a few
      // seconds early (clock skew, a backend that hasn't caught up with the
      // rotation). Force a refresh and resend once. Skipped in offline mode; a
      // streaming init.body could not be replayed, but no call site sends one.
      if (res.status !== 401 || offlineModeRef.current) return res;
      try {
        await performRefresh();
      } catch (e) {
        applyRefreshFailure(e);
        return res;
      }
      return send();
    },
    [ensureFreshToken, performRefresh, applyRefreshFailure],
  );

  const loginBasic = useCallback(
    async ({ server, username, password }: LoginArgs) => {
      setError(null);
      setLoading(true);
      setUser(null);
      setAuth(null);
      authRef.current = null;
      nextTokenRefreshRef.current = null;
      serverRef.current = normalizeServerUrl(server);
      setServerUrl(serverRef.current);
      localStorage.setItem(AUTH_SERVER_STORAGE_KEY, serverRef.current);
      try {
        if (!server || !username || !password)
          throw new Error("All fields are required.");
        const authData = await loginBasicRequest(username, password);
        authRef.current = authData;
        setAuth(authData);
        if (authData.refresh_token)
          localStorage.setItem(
            AUTH_REFRESH_STORAGE_KEY,
            authData.refresh_token,
          );
        nextTokenRefreshRef.current = authData.access_token
          ? computeNextTokenRefresh(authData.access_token)
          : new Date();
        const me = await fetchCurrentUser();
        setUser(me);
        if (isTauriApp()) {
          try {
            localStorage.setItem(AUTH_CACHED_USER_KEY, JSON.stringify(me));
          } catch { /* ignore */ }
        }
        return { auth: authData, user: me };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
        setBootstrapping(false);
      }
    },
    [],
  );

  const loginWithTokens = useCallback(
    async (server: string, tokens: AuthTokens) => {
      setError(null);
      setLoading(true);
      setUser(null);
      setAuth(null);
      authRef.current = null;
      nextTokenRefreshRef.current = null;
      serverRef.current = normalizeServerUrl(server);
      setServerUrl(serverRef.current);
      localStorage.setItem(AUTH_SERVER_STORAGE_KEY, serverRef.current);
      try {
        if (!tokens?.access_token) throw new Error("Missing access token");
        authRef.current = tokens;
        setAuth(tokens);
        if (tokens.refresh_token)
          localStorage.setItem(
            AUTH_REFRESH_STORAGE_KEY,
            tokens.refresh_token,
          );
        nextTokenRefreshRef.current = computeNextTokenRefresh(
          tokens.access_token,
        );
        const me = await fetchCurrentUser();
        setUser(me);
        if (isTauriApp()) {
          try {
            localStorage.setItem(AUTH_CACHED_USER_KEY, JSON.stringify(me));
          } catch { /* ignore */ }
        }
        return { auth: tokens, user: me };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
        setBootstrapping(false);
      }
    },
    [],
  );

  useEffect(() => {
    // Guard against React StrictMode double-mount.
    if (bootstrapRanRef.current) return;
    bootstrapRanRef.current = true;

    (async () => {
      const storedRefresh = localStorage.getItem(AUTH_REFRESH_STORAGE_KEY);
      const storedServer = localStorage.getItem(AUTH_SERVER_STORAGE_KEY);
      console.log("[bootstrap] storedRefresh:", !!storedRefresh, "storedServer:", !!storedServer, "isTauri:", isTauriApp());
      if (!storedRefresh || !storedServer) {
        const devAutologin = getDevAutologinConfig();
        if (!devAutologin) {
          setBootstrapping(false);
          return;
        }

        setLoading(true);
        setError(null);
        serverRef.current = devAutologin.server;
        setServerUrl(serverRef.current);
        localStorage.setItem(AUTH_SERVER_STORAGE_KEY, serverRef.current);
        try {
          const tokens = await loginBasicRequest(
            devAutologin.username,
            devAutologin.password,
          );
          if (!tokens.access_token) {
            throw new Error("No access_token in dev autologin response");
          }
          authRef.current = tokens;
          setAuth(tokens);
          if (tokens.refresh_token) {
            localStorage.setItem(
              AUTH_REFRESH_STORAGE_KEY,
              tokens.refresh_token,
            );
          }
          nextTokenRefreshRef.current = computeNextTokenRefresh(
            tokens.access_token,
          );
          const me = await fetchCurrentUser();
          setUser(me);
        } catch (e) {
          authRef.current = null;
          setAuth(null);
          setUser(null);
          nextTokenRefreshRef.current = null;
          localStorage.removeItem(AUTH_REFRESH_STORAGE_KEY);
          setError(
            e instanceof Error ? e.message : "Dev autologin failed.",
          );
        } finally {
          setLoading(false);
          setBootstrapping(false);
        }
        return;
      }
      serverRef.current = normalizeServerUrl(storedServer);
      setServerUrl(serverRef.current);
      offlineModeRef.current = false;

      // Safety: force offline bootstrap if network calls hang > 15s
      const safetyTimer = isTauriApp()
        ? setTimeout(() => {
            console.log("[bootstrap] SAFETY TIMER FIRED — forcing offline");
            const cachedUserRaw = localStorage.getItem(AUTH_CACHED_USER_KEY);
            console.log("[bootstrap] safety: cachedUser exists:", !!cachedUserRaw);
            if (cachedUserRaw) {
              try {
                const cachedUser: GamevaultUser = JSON.parse(cachedUserRaw);
                offlineModeRef.current = true;
                // access_token stays empty — never send the refresh token as a
                // Bearer access token. offlineModeRef gates network use.
                authRef.current = { access_token: "", refresh_token: storedRefresh };
                nextTokenRefreshRef.current = new Date(Date.now() + 24 * 60 * 60 * 1000);
                setAuth(authRef.current);
                setUser(cachedUser);
                setOfflineBootstrap(true);
              } catch { /* ignore */ }
            }
            setBootstrapping(false);
          }, 15_000)
        : null;

      try {
        console.log("[bootstrap] refreshing stored token...");
        // authRef is null here, so performRefresh reads the stored refresh token.
        await performRefresh();
        console.log("[bootstrap] refresh succeeded, fetching user...");
        const me = await fetchCurrentUser();
        setUser(me);
        if (isTauriApp()) {
          try {
            localStorage.setItem(AUTH_CACHED_USER_KEY, JSON.stringify(me));
          } catch { /* ignore */ }
        }
      } catch (e) {
        console.log("[bootstrap] refresh/fetch failed:", e instanceof Error ? e.message : String(e));
        if (classifyRefreshError(e) === "fatal") {
          // The stored refresh token was rejected by the server — it is dead.
          // Clear it; ProtectedRoute then shows the login screen.
          console.log("[bootstrap] refresh token rejected, clearing session");
          logout();
        } else if (isTauriApp()) {
          // Transient failure (network / server unreachable) — fall back to
          // offline bootstrap if we have a cached user.
          const cachedUserRaw = localStorage.getItem(AUTH_CACHED_USER_KEY);
          console.log("[bootstrap] cachedUser exists:", !!cachedUserRaw);
          if (cachedUserRaw) {
            try {
              const cachedUser: GamevaultUser = JSON.parse(cachedUserRaw);
              console.log("[bootstrap] entering OFFLINE MODE with cached user:", cachedUser.username);
              // Reconstruct minimal auth from the stored refresh token. access_token
              // stays empty — offlineModeRef gates network use until we recover.
              offlineModeRef.current = true;
              authRef.current = { access_token: "", refresh_token: storedRefresh };
              // Push expiry out so isTokenNearExpiry stays false; ensureFreshToken's
              // offline branch drives recovery.
              nextTokenRefreshRef.current = new Date(Date.now() + 24 * 60 * 60 * 1000);
              setAuth(authRef.current);
              setUser(cachedUser);
              setOfflineBootstrap(true);
            } catch {
              // Cache corrupted — clear it but keep refresh token so user can log in online
              localStorage.removeItem(AUTH_CACHED_USER_KEY);
              authRef.current = null;
              setAuth(null);
            }
          } else {
            // No cached user yet — keep refresh token so next online launch auto-logs in.
            // After one online session, app_cached_user will be populated.
            console.log("[bootstrap] no cached user, clearing auth (login page expected)");
            authRef.current = null;
            setAuth(null);
          }
        } else {
          localStorage.removeItem(AUTH_REFRESH_STORAGE_KEY);
          authRef.current = null;
          setAuth(null);
        }
      } finally {
        if (safetyTimer) { clearTimeout(safetyTimer); console.log("[bootstrap] safety timer cleared"); }
        console.log("[bootstrap] done, bootstrapping=false, authRef:", !!authRef.current, "offlineBootstrap:", offlineBootstrap);
        setBootstrapping(false);
      }
    })();
  }, []);

  // When coming back online after offline mode, re-authenticate
  useEffect(() => {
    if (!isTauriApp()) return;

    const unregister = onReconnect(async () => {
      console.log("[auth] reconnect callback fired, refreshing...");
      // performRefresh clears offlineModeRef on success. On failure,
      // applyRefreshFailure stays offline (transient) or logs out (dead token).
      if (!localStorage.getItem(AUTH_REFRESH_STORAGE_KEY)) return;

      try {
        await performRefresh();
        // Re-fetch user data now that we're back online
        const me = await fetchCurrentUser();
        setUser(me);
        console.log("[auth] re-authenticated successfully");
      } catch (e) {
        applyRefreshFailure(e);
      }
    });

    return unregister;
  }, [onReconnect, performRefresh, applyRefreshFailure]);

  // Proactively refresh the access token shortly before it expires, so it stays
  // valid even when nothing is calling authFetch (idle UI, the Rust play-time
  // tracker, which picks up the new token via useGameTimeTracker). Re-arms
  // whenever the token changes — i.e. after every successful refresh.
  useEffect(() => {
    const token = auth?.access_token;
    if (!token || offlineModeRef.current) return;
    const expMs = getJwtExpMs(token);
    if (expMs === null) return;
    // Floor the delay so a token that arrives already near expiry (bad server
    // clock, very short TTL) degrades to a slow refresh loop, not a hot one.
    const delay = Math.max(15_000, expMs - REFRESH_LEAD_MS - Date.now());
    const timer = setTimeout(() => {
      if (offlineModeRef.current) return;
      void performRefresh().catch(applyRefreshFailure);
    }, delay);
    return () => clearTimeout(timer);
  }, [auth?.access_token, performRefresh, applyRefreshFailure]);

  const refreshCurrentUser = useCallback(async () => {
    try {
      const me = await fetchCurrentUser();
      setUser(me);
      return me;
    } catch {
      return null;
    }
  }, []);

  const value: AuthContextValue = {
    serverUrl,
    auth,
    user,
    error,
    loading,
    bootstrapping,
    offlineBootstrap,
    loginBasic,
    loginWithTokens,
    logout,
    authFetch,
    refreshCurrentUser,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
