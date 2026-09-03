// Fetches the Ludusavi CLI (https://github.com/mtkennerly/ludusavi, MIT) and
// drops it into src-tauri/binaries/ as a Tauri "externalBin" sidecar, named for
// the Rust target triple so `tauri build`/`tauri dev` can find it.
//
// Runs automatically before `tauri dev` / `tauri build` (see package.json), and
// in CI before the bundle step. Safe to run repeatedly — it no-ops when the
// pinned version is already in place.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LUDUSAVI_VERSION = "0.31.0";

const BIN_DIR = path.resolve("src-tauri/binaries");
const MARKER = path.join(BIN_DIR, ".ludusavi-version");

// platform key -> { asset suffix, archive extension, binary name inside archive,
//                   default rust target triple, sidecar file extension }
const PLATFORMS = {
  "linux-x64": {
    asset: "linux",
    ext: "tar.gz",
    bin: "ludusavi",
    triple: "x86_64-unknown-linux-gnu",
    out: "",
  },
  "win32-x64": {
    asset: "win64",
    ext: "zip",
    bin: "ludusavi.exe",
    triple: "x86_64-pc-windows-msvc",
    out: ".exe",
  },
  "win32-ia32": {
    asset: "win32",
    ext: "zip",
    bin: "ludusavi.exe",
    triple: "i686-pc-windows-msvc",
    out: ".exe",
  },
  // Ludusavi ships a single x86_64 macOS build; on Apple Silicon it runs under
  // Rosetta 2. Name it for whichever triple the app is built against.
  "darwin-x64": {
    asset: "mac",
    ext: "tar.gz",
    bin: "ludusavi",
    triple: "x86_64-apple-darwin",
    out: "",
  },
  "darwin-arm64": {
    asset: "mac",
    ext: "tar.gz",
    bin: "ludusavi",
    triple: "aarch64-apple-darwin",
    out: "",
  },
};

function resolvePlatform() {
  const override = process.env.GV_LUDUSAVI_PLATFORM?.trim();
  const key = override || `${process.platform}-${process.arch}`;
  const platform = PLATFORMS[key];
  if (!platform) {
    throw new Error(
      `Unsupported platform "${key}" for the Ludusavi sidecar. ` +
        `Set GV_LUDUSAVI_PLATFORM to one of: ${Object.keys(PLATFORMS).join(", ")}.`,
    );
  }
  // Allow an explicit triple override (cross-compilation).
  const triple =
    process.env.GV_LUDUSAVI_TARGET_TRIPLE?.trim() || platform.triple;
  return { ...platform, triple };
}

async function main() {
  const platform = resolvePlatform();
  const sidecarPath = path.join(
    BIN_DIR,
    `ludusavi-${platform.triple}${platform.out}`,
  );
  const markerValue = `${LUDUSAVI_VERSION} ${platform.triple}`;

  const markerMatches =
    existsSync(MARKER) &&
    (await readFile(MARKER, "utf8")).trim() === markerValue;
  if (markerMatches && existsSync(sidecarPath)) {
    console.log(
      `Ludusavi ${LUDUSAVI_VERSION} sidecar already present (${path.basename(sidecarPath)}).`,
    );
    return;
  }

  await mkdir(BIN_DIR, { recursive: true });

  const assetName = `ludusavi-v${LUDUSAVI_VERSION}-${platform.asset}.${platform.ext}`;
  const url = `https://github.com/mtkennerly/ludusavi/releases/download/v${LUDUSAVI_VERSION}/${assetName}`;
  console.log(`Downloading ${assetName}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download Ludusavi (${response.status}) from ${url}`,
    );
  }
  const archiveBytes = Buffer.from(await response.arrayBuffer());

  const tmpDir = path.join(os.tmpdir(), `gamevault-ludusavi-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, assetName);
  await writeFile(archivePath, archiveBytes);

  // `tar` (bsdtar) ships with modern Windows and every Unix; it extracts both
  // .tar.gz and .zip.
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], {
    stdio: "inherit",
  });
  if (extract.status !== 0) {
    throw new Error(
      `Failed to extract ${assetName} (tar exit ${extract.status}).`,
    );
  }

  const extracted = path.join(tmpDir, platform.bin);
  if (!existsSync(extracted)) {
    throw new Error(
      `Ludusavi binary "${platform.bin}" not found in ${assetName}.`,
    );
  }

  await rm(sidecarPath, { force: true });
  await writeFile(sidecarPath, await readFile(extracted));
  if (!platform.out) {
    await chmod(sidecarPath, 0o755);
  }
  await rm(tmpDir, { recursive: true, force: true });
  await writeFile(MARKER, `${markerValue}\n`, "utf8");

  console.log(
    `Ludusavi ${LUDUSAVI_VERSION} ready at ${path.relative(process.cwd(), sidecarPath)}`,
  );
}

const dispatcher = globalThis[Symbol.for("undici.globalDispatcher.1")];
await main();
if (dispatcher?.close) {
  await dispatcher.close();
}
