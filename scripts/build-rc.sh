#!/usr/bin/env bash
#
# Local release-candidate build driver.
#
#   scripts/build-rc.sh            # build linux-x64 + windows-x64
#   scripts/build-rc.sh linux      # linux only  (.deb + AppImage)
#   scripts/build-rc.sh windows    # windows only (NSIS .exe, reuses last version)
#
# Produces  dist-rc/17.0.0-rc.<N>/  with each installer + its updater .sig and a
# SHA256SUMS file. <N> auto-increments (dist-rc/.rc-counter). Everything is local
# — nothing is pushed or published.
#
# The Windows build is cross-compiled from Linux via cargo-xwin and needs a bit
# of one-time host setup; the script checks for it and prints what's missing.
# Details: memory `rc-binary-builds`, and scripts/rc-build/unrar_sys-build.rs.
#
# The RC installers are signed with a *throwaway* updater key generated into
# .rc-build/ on first run, so the packaged app's "Check for updates" will not
# work on an RC build (that is expected).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
WORK="$REPO/.rc-build"          # gitignored scratch: key, wrappers, patched crate
BIN="$WORK/bin"
KEYFILE="$WORK/updater.key"
WHAT="${1:-both}"

LUDUSAVI_VERSION="0.31.0"

mkdir -p "$BIN" "$WORK/tmp"

# ── PATH: node/pnpm/cargo ──────────────────────────────────────────────────
for d in "$HOME"/.local/node-v*/bin "$HOME/.cargo/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH="$BIN:$PATH"
export NODE_OPTIONS="${NODE_OPTIONS:---dns-result-order=ipv4first}"
export APPIMAGE_EXTRACT_AND_RUN=1     # linuxdeploy is an AppImage; FUSE may be unavailable
export NO_STRIP=1
export XWIN_ACCEPT_LICENSE=1

cd "$REPO"

command -v pnpm  >/dev/null || { echo "ERROR: pnpm not on PATH"; exit 1; }
command -v cargo >/dev/null || { echo "ERROR: cargo not on PATH"; exit 1; }
[ -x node_modules/.bin/tauri ] || { echo "ERROR: run 'pnpm install' first"; exit 1; }

need_win_setup() {
  local miss=()
  command -v cargo-xwin >/dev/null || miss+=("cargo install --locked cargo-xwin")
  command -v clang-19   >/dev/null || miss+=("sudo apt install clang-19 lld-19")
  command -v makensis   >/dev/null || miss+=("sudo apt install nsis")
  rustup target list --installed 2>/dev/null | grep -q x86_64-pc-windows-msvc \
    || miss+=("rustup target add x86_64-pc-windows-msvc")
  if [ ${#miss[@]} -gt 0 ]; then
    echo "ERROR: windows cross-build prerequisites missing:"
    printf '  %s\n' "${miss[@]}"
    exit 1
  fi
}

# ── version ───────────────────────────────────────────────────────────────
mkdir -p dist-rc
COUNTER="dist-rc/.rc-counter"
if [[ "$WHAT" == "windows" && -f dist-rc/.last-ver ]]; then
  VER="$(cat dist-rc/.last-ver)"
else
  N=$(( $(cat "$COUNTER" 2>/dev/null || echo 0) + 1 ))
  echo "$N" > "$COUNTER"
  VER="17.0.0-rc.$N"
  echo "$VER" > dist-rc/.last-ver
fi
echo ">>> Release candidate $VER   (target: $WHAT)"

# ── throwaway updater signing key ─────────────────────────────────────────
if [[ ! -f "$KEYFILE" ]]; then
  echo ">>> generating throwaway updater signing key ($KEYFILE)"
  CI=true node_modules/.bin/tauri signer generate -w "$KEYFILE" -p "" -f --ci
fi
export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEYFILE")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
export GV_TAURI_UPDATER_PUBKEY="$(cat "$KEYFILE.pub")"

export GV_BUILD_VERSION="$VER"
export GV_BUILD_CHANNEL="rc"
export GV_BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ── stamp version / configs (reverted in the trap below) ──────────────────
STAMPED=(src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/debian-changelog
         src-tauri/linux/com.phalcode.gamevault.metainfo.xml)
for f in "${STAMPED[@]}"; do [ -f "$f" ] && cp -p "$f" "$WORK/tmp/$(basename "$f").orig"; done

restore() {
  for f in "${STAMPED[@]}"; do
    b="$WORK/tmp/$(basename "$f").orig"
    [ -f "$b" ] && cp -p "$b" "$f"
  done
  rm -f src-tauri/tauri.release.generated.json
}
trap restore EXIT

node scripts/write-tauri-release-config.mjs \
  src-tauri/tauri.release.conf.json src-tauri/tauri.release.generated.json
node scripts/write-cargo-version.mjs src-tauri/Cargo.toml "$VER"
node scripts/write-debian-changelog.mjs "$VER"
node scripts/write-tauri-metainfo.mjs

mkdir -p release-assets
BUNDLE="src-tauri/target/release/bundle"
WIN_BUNDLE="src-tauri/target/x86_64-pc-windows-msvc/release/bundle"

# ── Linux: .deb + AppImage ───────────────────────────────────────────────
if [[ "$WHAT" == "both" || "$WHAT" == "linux" ]]; then
  # prepare-tauri-release-assets.mjs takes the alphabetically-first bundle of
  # each type; clear stale ones (a shared target dir may carry old builds).
  rm -rf "$BUNDLE"/deb "$BUNDLE"/appimage "$BUNDLE"/rpm "$BUNDLE"/appimage_deb
  echo ">>> [linux] pnpm tauri build"
  pnpm tauri build --config src-tauri/tauri.release.generated.json --bundles appimage,deb
  node scripts/prepare-tauri-release-assets.mjs linux "$VER"
fi

# ── Windows: NSIS .exe via cargo-xwin ────────────────────────────────────
if [[ "$WHAT" == "both" || "$WHAT" == "windows" ]]; then
  need_win_setup

  # clang-cl wrapper: Ubuntu's clang ships no clang-cl; UnRAR (the only C++
  # crate) uses SSSE3/SSE4.2/AES-NI/PCLMUL intrinsics unconditionally under
  # _M_X64 and does its own CPUID dispatch, so enabling them globally matches
  # the MSVC build. clang-19 because xwin's MSVC STL static_asserts Clang >= 19.
  cat > "$BIN/clang-cl" <<'EOF'
#!/bin/sh
exec clang-19 --driver-mode=cl -mssse3 -msse4.2 -maes -mpclmul "$@"
EOF
  chmod +x "$BIN/clang-cl"
  for t in lld-link llvm-lib llvm-rc llvm-dlltool; do
    [ -x "/usr/lib/llvm-19/bin/$t" ] && ln -sf "/usr/lib/llvm-19/bin/$t" "$BIN/$t"
  done
  rm -f "$BIN/makensis" "$BIN/makensis.exe"   # avoid resolving to a prior self-symlink
  MK="$(command -v makensis)"                  # now falls through to the system copy
  ln -sf "$MK" "$BIN/makensis"
  ln -sf "$MK" "$BIN/makensis.exe"   # Tauri probes the .exe name on the windows target

  # xwin's SDK splat ships some headers/libs lowercase-only; UnRAR includes
  # them mixed-case. Plus an empty pthread.lib (unrar_sys build.rs wrongly
  # requests pthread when the *host* is unix; UnRAR uses Win32 threads here).
  XUM="$HOME/.cache/cargo-xwin/xwin/sdk/include/um"
  XLIB="$HOME/.cache/cargo-xwin/xwin/sdk/lib/um/x86_64"
  if [ -d "$XUM" ]; then
    [ -e "$XUM/PowrProf.h" ] || ln -sf powrprof.h "$XUM/PowrProf.h"
    [ -e "$XUM/Wbemidl.h" ]  || ln -sf WbemIdl.h  "$XUM/Wbemidl.h"
  fi
  if [ -d "$XLIB" ]; then
    [ -e "$XLIB/PowrProf.lib" ] || ln -sf powrprof.lib "$XLIB/PowrProf.lib"
    if [ ! -e "$XLIB/pthread.lib" ]; then
      : > "$WORK/tmp/empty.c"
      "$BIN/clang-cl" --target=x86_64-pc-windows-msvc -c "$WORK/tmp/empty.c" -o "$WORK/tmp/empty.obj"
      "$BIN/llvm-lib" /out:"$XLIB/pthread.lib" "$WORK/tmp/empty.obj"
    fi
  fi

  # Ludusavi win64 sidecar (fetch-ludusavi.mjs can't unzip on Linux — GNU tar).
  SIDE="src-tauri/binaries/ludusavi-x86_64-pc-windows-msvc.exe"
  if [ ! -f "$SIDE" ]; then
    echo ">>> [windows] fetching Ludusavi $LUDUSAVI_VERSION win64 sidecar"
    curl -fSL -o "$WORK/tmp/lud-win.zip" \
      "https://github.com/mtkennerly/ludusavi/releases/download/v$LUDUSAVI_VERSION/ludusavi-v$LUDUSAVI_VERSION-win64.zip"
    unzip -o "$WORK/tmp/lud-win.zip" ludusavi.exe -d "$WORK/tmp"
    mkdir -p src-tauri/binaries
    cp "$WORK/tmp/ludusavi.exe" "$SIDE"
  fi

  # Patched unrar_sys (see scripts/rc-build/unrar_sys-build.rs). Copy the crate
  # out of the cargo registry and swap its build.rs.
  UPATCH="$WORK/unrar_sys"
  if [ ! -f "$UPATCH/build.rs.patched" ]; then
    SRC="$(find "$HOME/.cargo/registry/src" -maxdepth 3 -type d -name 'unrar_sys-0.5.8' | head -1)"
    [ -n "$SRC" ] || { echo "ERROR: unrar_sys-0.5.8 not in cargo registry — run 'pnpm install'/'cargo fetch'"; exit 1; }
    rm -rf "$UPATCH"; cp -r "$SRC" "$UPATCH"; chmod -R u+w "$UPATCH"
    cp "$SCRIPT_DIR/rc-build/unrar_sys-build.rs" "$UPATCH/build.rs"
    touch "$UPATCH/build.rs.patched"
  fi
  if ! grep -q 'patch.crates-io' src-tauri/Cargo.toml; then
    printf '\n[patch.crates-io]\nunrar_sys = { path = "%s" }\n' "$UPATCH" >> src-tauri/Cargo.toml
  fi

  rm -rf "$WIN_BUNDLE"/nsis "$BUNDLE"/nsis
  echo ">>> [windows] pnpm tauri build --runner cargo-xwin  ($("$BIN/clang-cl" --version | head -1))"
  pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc \
    --config src-tauri/tauri.release.generated.json --bundles nsis

  # prepare-tauri-release-assets.mjs only looks in target/release/bundle
  mkdir -p "$BUNDLE"
  cp -r "$WIN_BUNDLE"/nsis "$BUNDLE"/
  RUNNER_ARCH=x64 node scripts/prepare-tauri-release-assets.mjs windows "$VER"
fi

# ── collect ─────────────────────────────────────────────────────────────
OUT="dist-rc/$VER"
mkdir -p "$OUT"
[ -d release-assets/linux ]   && cp -f release-assets/linux/*   "$OUT/" 2>/dev/null || true
[ -d release-assets/windows ] && cp -f release-assets/windows/* "$OUT/" 2>/dev/null || true
( cd "$OUT" && rm -f SHA256SUMS && sha256sum -- * > SHA256SUMS )

echo
echo ">>> done — $REPO/$OUT"
ls -la "$OUT"
