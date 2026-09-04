# GameVault Web Frontend

React 19 + Vite + Tailwind (v4) powered frontend for the GameVault platform.

## Attribution & Fork Notice

This is a **modified fork** of the original [GameVault Web Frontend](https://github.com/Phalcode/gamevault-frontend)
by **Phalcode** (Alkan Alper, Schäfer Philip GbR). All credit for the original
application goes to them.

This fork exists specifically to add and improve **Linux desktop support** —
for example native Linux game installers (GOG-style `.sh`), correct Linux
uninstaller handling, a separate SSO login window on the desktop app, and the
bundled Ludusavi save-file sync sidecar. Changes have been made relative to
upstream and are not endorsed by Phalcode.

The original is licensed under **CC BY-NC-SA 4.0**, and this fork is
distributed under the same license (see [LICENSE](LICENSE)). Non-commercial use
only; derivatives must keep this attribution and the same license.

## Tech Stack

- PNPM
- React
- TypeScript
- Vite
- Tailwind CSS, Tailwind UI-Kit & Tailwind Components
- Tauri
- React Router

## Setup

`pnpm install`

## Scripts

- dev/start: Run local development server
- build: Production build
- preview: Preview production build locally
- lint: Run ESLint

## Notes

The project was migrated from a basic Vite template; most custom styling now relies on Tailwind utilities with a small set of extended theme tokens.

## Authentication Integration

The UI has been reconnected to the original authentication and user management logic:

- `AuthProvider` (`src/context/AuthContext.tsx`) handles login, token refresh, persistence, and exposes `authFetch` for authorized requests.
- `Login` component now performs real login against a GameVault backend and redirects to `/library` on success.
- Route guards in `src/main.tsx` prevent unauthenticated access to dashboard pages and redirect authenticated users away from the login screen.
- Admin Users page (`src/pages/Administration.tsx`) fetches real users and supports activation toggling, role changes, deletion and recovery through `useAdminUsers` (`src/hooks/useAdminUsers.ts`).

Persistence keys:

- `app_refresh_token` (refresh token)
- `app_server_url` (last used server base URL)

## Dev Autologin

Create `gamevault-frontend/.env.local` for dev-only automatic basic login:

```env
VITE_DEV_AUTOLOGIN=true
VITE_DEV_AUTOLOGIN_SERVER=https://example.gamevault.tld
VITE_DEV_AUTOLOGIN_USERNAME=devuser
VITE_DEV_AUTOLOGIN_PASSWORD=devpassword
```

- `.env.local` stays local because `*.local` already ignored.
- Autologin runs only in Vite dev mode and only when no refresh token exists yet.
- Login page reuses stored server URL, so failed refresh or failed dev autologin still lands on right server.
- Restart `pnpm dev` after changing env file.

Uncheck "Remember me" on login if you want the refresh token removed right after authenticating (session-only access token).

If backend endpoints change, update the paths in `AuthContext` and the admin hook.

## Playtime Tracking

The desktop app records playtime for installed games. A background loop in
`src-tauri/src/time_tracker.rs` wakes every 60s, scans running processes, and for
any installed game that is running sends
`PUT /api/progresses/user/<id>/game/<id>/increment` (one minute per tick). On a
network failure the minute is written to `.gamevault.offline_time.json` next to the
game and flushed on the next reconnect. Game launch is fully decoupled — the loop
discovers the running game by polling, not from the "Play" button.

### Verifying it works

The tracker logs through `tauri-plugin-log` (enabled in debug **and** release
builds). Watch the log while a game runs:

- Dev: `pnpm tauridev`, logs go to stdout and `~/.local/share/com.phalcode.gamevault/logs/gamevault.log`.
- Packaged: run the binary from a terminal; logs also go to `~/.local/share/<identifier>/logs/`.

Expected lines (one per minute, per running game):

```
INFO  app_lib::time_tracker  playtime +1min: "Hollow Knight" (game 42) -> HTTP 204
```

`DEBUG` lines (candidate executables, `match: … <- pid …`, the request URL, and
`tick: no tracked game running`) are on for the `app_lib::time_tracker` target.
A non-2xx response is logged as `WARN playtime NOT recorded: … -> HTTP 401`.

To avoid waiting a full minute per increment, set
`GAMEVAULT_TRACKER_INTERVAL_SECS` (minimum 1) before launching the app:

```bash
GAMEVAULT_TRACKER_INTERVAL_SECS=5 pnpm tauridev
```

This is **test-only** — the server still counts a fixed 1 minute per tick, so a
short interval over-reports playtime.

## Desktop Auto-Updates

The desktop app (Tauri) updates itself from GitHub Releases.

**Channels** – switchable in **Settings → Desktop → Update channel**:

| Channel    | Branch    | Feed                                       |
| ---------- | --------- | ------------------------------------------ |
| `stable`   | `master`  | `releases/latest/download/latest.json`     |
| `unstable` | `develop` | `releases/download/unstable/unstable.json` |

The choice is persisted in `localStorage` (`gv_update_channel`).

**How it works** – on startup or via `Check for updates`, the frontend calls the Tauri updater through Rust commands in `src-tauri/src/lib.rs`. The app confirms with the user, downloads, verifies the signature, and installs. If the feed is not published yet, it falls back to the GitHub release page.

**Versioning** – stable uses the plain `package.json`/`Cargo.toml` version. Unstable builds get a CI-generated unique version `17.0.0-unstable.<run>.<attempt>` (same semver core, only the `unstable` suffix bumps), injected into both the web and Rust builds and into the feed.

**CI** – `.github/workflows/deploy.yml` builds signed updater artifacts per OS (`.exe`+`.sig`, `.app.tar.gz`+`.sig`, `.AppImage`+`.sig`), merges them into `updater-channels.json`, and derives `latest.json` / `unstable.json`. Stale `unstable` assets are cleaned up automatically.

**Required GitHub config** – under **Settings → Secrets and variables → Actions**:

- Variable `GV_TAURI_UPDATER_PUBKEY` (public key content)
- Secret `TAURI_SIGNING_PRIVATE_KEY` (private key content)
- Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (optional)

Generate the keys once with `cargo tauri signer generate -w ~/.tauri/gamevault-updater.key`. Keep the private key and password safe — losing them breaks updates for existing installs.

**Local builds** – a normal `tauri build` produces no updater artifacts. To create them locally, build with the release config and signing env (`pnpm tauri build --config src-tauri/tauri.release.conf.json`). CI uses `src-tauri/tauri.release.generated.json` with the pubkey injected, since the Tauri bundler requires `plugins.updater.pubkey` in the parsed config.

## Release-candidate binaries

`scripts/build-rc.sh` builds local RC installers into `dist-rc/17.0.0-rc.<N>/`
(auto-incrementing `<N>`), each with a `.sig` and a `SHA256SUMS`:

```bash
pnpm install
scripts/build-rc.sh            # linux-x64 (.deb + AppImage) + windows-x64 (NSIS .exe)
scripts/build-rc.sh linux      # linux only
scripts/build-rc.sh windows    # windows only
```

It signs with a **throwaway** updater key kept in `.rc-build/` (both gitignored), so
"Check for updates" does not work on an RC build — that is expected.

The Windows target is cross-compiled from Linux with `cargo-xwin`; the script checks
for the host prerequisites and prints what to install (`clang-19 lld-19`, `nsis`,
`cargo-xwin`, the `x86_64-pc-windows-msvc` rustup target). It also applies a small
`unrar_sys` build-script fix (`scripts/rc-build/unrar_sys-build.rs`) for the duration
of the build — the upstream crate's `build.rs` inspects the build host instead of the
target and breaks cross-compilation.
